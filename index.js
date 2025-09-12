const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const winston = require('winston');
const { LoggingWinston } = require('@google-cloud/logging-winston');
const { createClient } = require('@supabase/supabase-js');
const usb = require('usb');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');

// -------------------- CONFIG --------------------
const VID = 0x0493;
const PID = 0x8760;
const WIDTH_NORMAL = 48;
const WIDTH_DOUBLE = 24;

const PRINTER_TIMEOUT = 8_000;
const MAX_RETRIES = 3;
const QUEUE_MAX_LENGTH = 300;
const RETRY_BACKOFF_BASE = 1_000;
const LISTENER_BACKOFF_BASE = 1_000;

// -------------------- LOGGING --------------------
const transports = [
   new winston.transports.Console({
      format: winston.format.combine(
         winston.format.colorize(),
         winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
         winston.format.printf(i => `[${i.timestamp}] ${i.level}: ${i.message}`),
      ),
   }),
];
if (process.env.GOOGLE_PROJECT_ID && process.env.GCP_KEY_PATH) {
   const loggingWinston = new LoggingWinston({
      projectId: process.env.GOOGLE_PROJECT_ID,
      keyFilename: path.join(__dirname, process.env.GCP_KEY_PATH),
   });
   transports.push(loggingWinston);
}
const logger = winston.createLogger({
   level: process.env.LOG_LEVEL || 'info',
   defaultMeta: { service: 'pos-printer' },
   transports,
});

// -------------------- SUPABASE --------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
   auth: { persistSession: false, autoRefreshToken: false },
});

// -------------------- HELPERS --------------------
const wait = ms => new Promise(res => setTimeout(res, ms));
const LINE_DIVIDER = '-'.repeat(WIDTH_NORMAL);

const formatCurrency = amount => {
   if (amount === undefined || amount === null) return '$0';
   return (
      '$' +
      Math.floor(Number(amount) || 0)
         .toString()
         .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
   );
};

const formatPhone = phone => {
   if (!phone) return '';
   const cleaned = String(phone).replace(/\D/g, '');
   if (cleaned.length === 10) return cleaned.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
   return phone;
};

const drawRow = (left, right, fillChar = ' ', maxCols = WIDTH_NORMAL) => {
   const l = String(left || '').substring(0, 32);
   const r = String(right || '');
   let space = maxCols - l.length - r.length;
   if (space < 1) space = 1;
   return l + fillChar.repeat(space) + r;
};

const isValidJobPayload = p => {
   if (!p || typeof p !== 'object') return false;
   if (!p.invoice || typeof p.invoice !== 'object') return false;
   if (!p.totals || typeof p.totals.total !== 'number') return false;
   if (!Array.isArray(p.items)) return false;
   return true;
};

// -------------------- PRINTER CONNECTION (persistent) --------------------
let persistentDevice = null;
let persistentPrinter = null;
let isDeviceInitializing = false;

const cleanupPrinterConnection = () => {
   if (persistentPrinter) {
      try {
         persistentPrinter.close();
      } catch (e) {}
   }
   if (persistentDevice) {
      try {
         persistentDevice.close();
      } catch (e) {}
   }

   persistentDevice = null;
   persistentPrinter = null;
   isDeviceInitializing = false;
};

const promisifiedDeviceOpen = device =>
   new Promise((resolve, reject) => {
      try {
         device.open(err => {
            if (err) return reject(err);
            resolve();
         });
      } catch (err) {
         reject(err);
      }
   });

const getPrinterConnection = async () => {
   if (persistentDevice && persistentPrinter) {
      return { device: persistentDevice, printer: persistentPrinter };
   }

   if (isDeviceInitializing) {
      let waited = 0;
      while (isDeviceInitializing && waited < 5000) {
         await wait(200);
         waited += 200;
      }
      if (persistentDevice && persistentPrinter) {
         return { device: persistentDevice, printer: persistentPrinter };
      }
   }

   isDeviceInitializing = true;

   try {
      const device = new escpos.USB(VID, PID);
      await promisifiedDeviceOpen(device);

      const options = { encoding: 'cp850', width: WIDTH_NORMAL };
      const printer = new escpos.Printer(device, options);

      persistentDevice = device;
      persistentPrinter = printer;
      isDeviceInitializing = false;
      logger.info('Printer connected (USB).');

      return { device, printer };
   } catch (err) {
      isDeviceInitializing = false;
      cleanupPrinterConnection();
      throw err;
   }
};

usb.on('detach', device => {
   if (!device || !device.deviceDescriptor) return;
   if (device.deviceDescriptor.idVendor === VID && device.deviceDescriptor.idProduct === PID) {
      logger.warn('Printer USB detached -> cleaning connection');
      cleanupPrinterConnection();
   }
});

usb.on('attach', device => {
   if (!device || !device.deviceDescriptor) return;
   if (device.deviceDescriptor.idVendor === VID && device.deviceDescriptor.idProduct === PID) {
      logger.info('Printer USB attached -> attempting quick reconnect');
      getPrinterConnection().catch(e =>
         logger.warn('Reconnect on attach failed', { error: e?.message || e }),
      );
   }
});

// -------------------- PRINT ROUTINE (single job) --------------------
const performPrint = async (jobId, data, retryCount = 0) => {
   if (!isValidJobPayload(data)) throw new Error('Invalid job payload');

   let timeoutHandle;

   try {
      const { printer } = await getPrinterConnection();
      const printingTask = new Promise((resolve, reject) => {
         try {
            const items = Array.isArray(data.items) ? data.items : [];
            const company = data.company || {};
            const invoice = data.invoice || {};
            const totals = data.totals || { subtotal: 0, discount: 0, total: 0 };
            const customer = data.customer || {};
            const payments = data.payments || [];

            // HEADER
            printer
               .font('a')
               .align('ct')
               .style('b')
               .size(1, 1)
               .text(String(company.name || ''));
            printer
               .size(0, 0)
               .style('n')
               .text(`NIT: ${company.nit || ''}`);
            if (company.regime) printer.text(String(company.regime));
            if (company.address) printer.text(String(company.address));
            if (company.phone) printer.style('n').text(`TEL: ${formatPhone(company.phone)}`);

            printer.text(LINE_DIVIDER);

            // INVOICE INFO
            printer.align('lt').style('b');
            printer.text(drawRow('FACTURA:', invoice.number || '---'));
            printer.style('n');
            printer.text(drawRow('ASESOR:', String(invoice.cashier || '').toUpperCase()));
            printer.text(drawRow('FECHA:', invoice.date || ''));
            printer.text(drawRow('HORA:', invoice.time || ''));

            printer.text(LINE_DIVIDER);

            // CLIENT
            if (customer.name) {
               printer.text(
                  drawRow('CLIENTE:', String(customer.name).toUpperCase().substring(0, 20)),
               );
               if (customer.id_number) printer.text(drawRow('NIT/CC:', String(customer.id_number)));
               printer.text(LINE_DIVIDER);
            }

            // ITEMS
            items.forEach(item => {
               printer
                  .style('b')
                  .text(String(item.description || '').toUpperCase())
                  .style('n');
               const qty = Number(item.qty) || 0;
               const price = Number(item.price) || 0;
               const totalItem = qty * price;
               const left = `${qty} x ${formatCurrency(price)}`;
               printer.text(drawRow(left, formatCurrency(totalItem)));
            });

            printer.text(LINE_DIVIDER);

            // TOTALS
            if ((totals.discount || 0) > 0) {
               printer.text(drawRow('SUBTOTAL:', formatCurrency(totals.subtotal)));
               printer.text(drawRow('DESCUENTO:', `-${formatCurrency(totals.discount)}`));
            }

            printer.feed(1);
            printer.size(1, 1).style('b');
            printer.text(drawRow('TOTAL:', formatCurrency(totals.total || 0), ' ', WIDTH_DOUBLE));
            printer.style('n').size(0, 0);

            printer.text(LINE_DIVIDER);

            // PAYMENTS
            printer.align('ct').style('b').text('MEDIOS DE PAGO');

            const sumByMethod = method =>
               payments
                  .filter(p => p.method === method)
                  .reduce((a, b) => a + (Number(b.amount) || 0), 0);

            const cash = sumByMethod('cash');
            const transfer = sumByMethod('bank_transfer');
            const card = sumByMethod('credit_card');
            const balance = sumByMethod('account_balance');

            printer.style('n').align('lt');
            printer.text(drawRow('EFECTIVO', formatCurrency(cash)));
            if (transfer > 0 || (card < 1 && balance < 1)) {
               printer.text(drawRow('TRANSFERENCIA', formatCurrency(transfer)));
            }
            if (card > 0) printer.text(drawRow('TARJETA', formatCurrency(card)));
            if (balance > 0) printer.text(drawRow('SALDO FAVOR', formatCurrency(balance)));

            printer.text('.'.repeat(WIDTH_NORMAL));

            const totalPaid = cash + transfer + card + balance;
            const change = Math.max(0, totalPaid - (totals.total || 0));
            printer
               .style('b')
               .text(drawRow('CAMBIO', formatCurrency(change)))
               .style('n');

            // FOOTER
            printer.feed(2).align('ct');
            const footer = company.footer || 'Gracias por su compra';
            String(footer)
               .split('\n')
               .forEach(l => printer.text(l.trim()));

            printer.text('-'.repeat(WIDTH_NORMAL));

            printer.text('Sistema: sebasxs.com/smartpos');
            printer.feed(3);

            printer.cut();

            setTimeout(() => resolve(), 100);
         } catch (err) {
            reject(err);
         }
      });

      // timeout hardware
      const timeoutPromise = new Promise((_, reject) => {
         timeoutHandle = setTimeout(() => {
            reject(new Error('Printer hardware timeout (buffer stuck)'));
         }, PRINTER_TIMEOUT);
      });

      await Promise.race([printingTask, timeoutPromise]);
      logger.info('Print success', { jobId });
   } catch (err) {
      logger.error(`Print failed (attempt ${retryCount + 1}/${MAX_RETRIES})`, {
         jobId,
         error: err?.message || err,
      });
      cleanupPrinterConnection();
      if (retryCount < MAX_RETRIES) {
         const backoff = RETRY_BACKOFF_BASE * Math.pow(2, retryCount);
         await wait(backoff);
         return performPrint(jobId, data, retryCount + 1);
      }
      throw err;
   } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
   }
};

const printTicketSafe = async (jobId, payload) => {
   try {
      await performPrint(jobId, payload);
      await supabase.from('print_jobs').update({ status: 'printed' }).eq('id', jobId);
   } catch (err) {
      logger.error('Job processing failed', { jobId, error: err?.message || err });
      await supabase
         .from('print_jobs')
         .update({
            status: 'error',
         })
         .eq('id', jobId);
   }
};

// -------------------- QUEUE (bounded single-worker) --------------------
class PrintQueue {
   constructor(concurrency = 1, maxLength = QUEUE_MAX_LENGTH) {
      this.concurrency = concurrency;
      this.maxLength = maxLength;
      this.queue = [];
      this.running = 0;
   }

   size() {
      return this.queue.length;
   }

   push(job) {
      if (this.queue.length >= this.maxLength) {
         logger.warn('Queue full - rejecting job', { jobId: job.id });
         return false;
      }
      if (this.queue.some(j => j.id === job.id)) {
         logger.warn('Duplicate job detected - skipping enqueue', { jobId: job.id });
         return false;
      }
      this.queue.push(job);
      setImmediate(() => this.next());
      return true;
   }

   async next() {
      if (this.running >= this.concurrency) return;
      const job = this.queue.shift();
      if (!job) return;
      this.running++;
      try {
         await printTicketSafe(job.id, job.payload);
      } catch (e) {
         logger.error('Error processing job from queue', { jobId: job.id, error: e?.message || e });
      } finally {
         this.running--;
         setImmediate(() => this.next());
      }
   }
}

const queue = new PrintQueue();

const addToQueue = (id, payload) => {
   if (!isValidJobPayload(payload)) {
      logger.warn('Invalid payload received - marking job error', { jobId: id });
      supabase
         .from('print_jobs')
         .update({ status: 'error' })
         .eq('id', id)
         .catch(() => {});
      return;
   }
   const pushed = queue.push({ id, payload });
   if (pushed) {
      logger.info('Job added to queue', { jobId: id, queueSize: queue.size() });
   } else {
      supabase
         .from('print_jobs')
         .update({ status: 'error' })
         .eq('id', id)
         .catch(() => {});
   }
};

// -------------------- SUPABASE REALTIME + PENDING FETCHER --------------------
let channel = null;
let listenerAttempt = 0;

const processPending = async () => {
   try {
      const { data, error } = await supabase
         .from('print_jobs')
         .select('*')
         .eq('status', 'pending')
         .order('created_at', { ascending: true })
         .limit(100);
      if (error) throw error;
      if (data && data.length > 0) {
         logger.info(`Recovered ${data.length} pending jobs`);
         data.forEach(job => addToQueue(job.id, job.payload));
      }
   } catch (err) {
      logger.error('Failed to fetch pending print jobs', { error: err?.message || err });
   }
};

const createChannel = () =>
   supabase
      .channel('print_jobs_realtime')
      .on(
         'postgres_changes',
         { event: 'INSERT', schema: 'public', table: 'print_jobs' },
         payload => {
            if (payload?.new?.status === 'pending') addToQueue(payload.new.id, payload.new.payload);
         },
      );

const setupListener = async () => {
   if (channel && (channel.state === 'joined' || channel.state === 'joining')) return;
   logger.info('Starting Supabase realtime listener');
   if (channel) {
      try {
         const oldChannel = channel;
         channel = null;
         await supabase.removeChannel(oldChannel);
      } catch (e) {
         logger.warn('Failed to remove previous channel', { error: e?.message || e });
      }
   }

   try {
      const newChannel = createChannel();
      newChannel.subscribe(async status => {
         if (status === 'SUBSCRIBED') {
            listenerAttempt = 0;
            channel = newChannel;
            logger.info('Realtime connected');
            await processPending();
         } else if (['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT'].includes(status)) {
            logger.warn(`Supabase channel status: ${status}`);

            await supabase.removeChannel(newChannel).catch(() => {});
            if (channel === newChannel) channel = null;

            listenerAttempt++;
            const backoff = LISTENER_BACKOFF_BASE * Math.pow(2, Math.max(0, listenerAttempt - 1));
            setTimeout(setupListener, backoff);
         } else {
            logger.info(`Channel event: ${status}`);
         }
      });

      channel = newChannel;
   } catch (err) {
      logger.error('Failed to setup Supabase listener', { error: err?.message || err });
      listenerAttempt++;
      const backoff = LISTENER_BACKOFF_BASE * Math.pow(2, Math.max(0, listenerAttempt - 1));
      setTimeout(setupListener, backoff);
   }
};

// -------------------- STARTUP & WATCHDOG --------------------
logger.info('Printer agent starting');
setupListener().catch(e =>
   logger.warn('Initial listener setup failed', { error: e?.message || e }),
);
processPending().catch(e =>
   logger.warn('Initial pending fetch failed', { error: e?.message || e }),
);

setInterval(() => {
   try {
      const shouldRestart =
         !channel || ['CLOSED', 'ERRORED', 'CHANNEL_ERROR'].includes(channel?.state?.toUpperCase());
      if (shouldRestart) {
         logger.warn('Watchdog: restarting listener');
         setupListener().catch(e =>
            logger.error('Watchdog failed to setup listener', { error: e?.message || e }),
         );
      }
      processPending().catch(e =>
         logger.error('Watchdog failed to process pending', { error: e?.message || e }),
      );
   } catch (err) {
      logger.error('Watchdog error', { error: err?.message || err });
   }
}, 60_000);

// -------------------- SIGNALS & ERROR HANDLING --------------------
const shutdown = () => {
   logger.info('Service shutting down - cleaning resources');
   cleanupPrinterConnection();
   process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', err => {
   logger.error('Uncaught exception', { error: err?.message || err, stack: err?.stack });
   cleanupPrinterConnection();
   setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', reason => {
   logger.error('Unhandled rejection', { reason: reason?.message || reason });
});
