const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const winston = require('winston');
const { LoggingWinston } = require('@google-cloud/logging-winston');

const { createClient } = require('@supabase/supabase-js');
const usb = require('usb');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');

if (!usb.on) {
   usb.on = function () {};
   usb.removeListener = function () {};
}

const VID = 0x0493;
const PID = 0x8760;
const WIDTH_NORMAL = 48;
const WIDTH_DOUBLE = 24;
const LINE_DIVIDER = '-'.repeat(WIDTH_NORMAL);
const PRINTER_TIMEOUT = 10000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
   auth: { persistSession: false, autoRefreshToken: false },
   realtime: {
      params: {
         eventsPerSecond: 10,
      },
   },
});

const loggingWinston = new LoggingWinston({
   projectId: process.env.GOOGLE_PROJECT_ID,
   keyFilename: path.join(__dirname, 'gcp-key.json'),
});

const logger = winston.createLogger({
   level: 'info',
   transports: [
      new winston.transports.Console({
         format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
      }),
      loggingWinston,
   ],
});

const drawRow = (leftStr, rightStr, fillChar = ' ', maxCols = WIDTH_NORMAL) => {
   let left = String(leftStr || '').substring(0, 32);
   let right = String(rightStr || '');
   let spaceNeeded = maxCols - left.length - right.length;
   if (spaceNeeded < 1) spaceNeeded = 1;
   return left + fillChar.repeat(spaceNeeded) + right;
};

const formatCurrency = amount => {
   if (amount === undefined || amount === null) return '$0';
   return (
      '$' +
      Math.floor(amount)
         .toString()
         .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
   );
};

const formatPhone = phone => {
   if (!phone) return '';
   const cleaned = phone.replace(/\D/g, '');
   if (cleaned.length === 10) {
      return cleaned.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
   }
   return phone;
};

const updateJobStatus = async (id, status) => {
   try {
      const payload = { status: status };
      await supabase.from('print_jobs').update(payload).eq('id', id);
   } catch (e) {
      logger.error('Failed to update job status', { jobId: id, error: e.message, stack: e.stack });
   }
};

const performPrint = (jobId, data) => {
   return new Promise((resolve, reject) => {
      let device = null;
      let printer = null;

      try {
         device = new escpos.USB(VID, PID);
         const options = { encoding: 'cp850', width: WIDTH_NORMAL };
         printer = new escpos.Printer(device, options);
      } catch (err) {
         return reject(err);
      }

      logger.info('Print job started', { jobId });

      const items = Array.isArray(data.items) ? data.items : [];

      device.open(async function (error) {
         if (error) {
            return reject(new Error(`Cannot open printer: ${error.message}`));
         }

         try {
            const companyName = data.company?.name;
            const companyPhone = formatPhone(data.company?.phone || '');
            const cashier = data.invoice?.cashier?.toUpperCase() || 'ASESOR';
            const address = data.company?.address;

            // ================= HEADER =================
            printer
               .font('a')
               .align('ct')
               .style('b')
               .size(1, 1)
               .text(companyName)
               .size(0, 0)
               .style('n')
               .text(`NIT: ${data.company?.nit || ''}`);

            if (data.company?.regime) printer.text(data.company.regime);
            if (address) printer.text(address);
            if (companyPhone) printer.style('n').text(`TEL: ${companyPhone}`).style('n');

            printer.text(LINE_DIVIDER);

            // ================= INVOICE INFO =================
            printer.align('lt');

            printer.style('b');
            printer.text(drawRow('FACTURA:', data.invoice?.number || '---'));
            printer.style('n');

            printer.text(drawRow('ASESOR:', cashier));
            printer.text(drawRow('FECHA:', data.invoice.date));
            printer.text(drawRow('HORA:', data.invoice.time));

            printer.text(LINE_DIVIDER);

            // ================= CUSTOMER =================
            if (data.customer?.name) {
               const customerName = data.customer?.name.toUpperCase();
               printer.text(drawRow('CLIENTE:', customerName));

               if (data.customer?.id_number) {
                  printer.text(drawRow('NIT/CC:', data.customer.id_number));
               }

               printer.text(LINE_DIVIDER);
            }

            // ================= ITEMS =================
            items.forEach(item => {
               printer.style('b').text(item.description.toUpperCase()).style('n');

               const detailLeft = `${item.qty} x ${formatCurrency(item.price)}`;
               const totalItem = item.qty * item.price;
               const detailRight = formatCurrency(totalItem);

               printer.text(drawRow(detailLeft, detailRight));
            });

            printer.text(LINE_DIVIDER);

            // ================= TOTALS =================
            if (data.totals.discount > 0) {
               printer.text(drawRow('SUBTOTAL:', formatCurrency(data.totals.subtotal)));
               printer.text(drawRow('DESCUENTO:', `-${formatCurrency(data.totals.discount)}`));
            }

            printer.feed(1);
            printer.size(1, 1).style('b');
            printer.text(drawRow('TOTAL:', formatCurrency(data.totals.total), ' ', WIDTH_DOUBLE));
            printer.style('n').size(0, 0);

            printer.text(LINE_DIVIDER);

            // ================= PAYMENT METHODS =================
            printer.align('ct').style('b').text('MEDIOS DE PAGO').style('n').align('lt');

            const getAmount = methodKey => {
               return (data.payments || [])
                  .filter(p => p.method === methodKey)
                  .reduce((acc, curr) => acc + (curr.amount || 0), 0);
            };

            const cashAmount = getAmount('cash');
            const transferAmount = getAmount('bank_transfer');
            const balanceAmount = getAmount('account_balance');
            const cardAmount = getAmount('credit_card');

            printer.text(drawRow('EFECTIVO', formatCurrency(cashAmount)));
            printer.text(drawRow('TRANSFERENCIA', formatCurrency(transferAmount)));

            if (cardAmount > 0) {
               printer.text(drawRow('TARJETA', formatCurrency(cardAmount)));
            }
            if (balanceAmount > 0) {
               printer.text(drawRow('SALDO FAVOR', formatCurrency(balanceAmount)));
            }

            printer.text('.'.repeat(WIDTH_NORMAL));

            const totalPagado = cashAmount + transferAmount + balanceAmount + cardAmount;
            const cambio = Math.max(0, totalPagado - data.totals.total);

            printer.style('b');
            printer.text(drawRow('CAMBIO', formatCurrency(cambio)));
            printer.style('n');

            // ================= FOOTER =================
            printer.feed(2);
            printer.align('ct');

            const footerText = data.company?.footer || 'Gracias por su compra';
            const lines = footerText.split('\n');
            lines.forEach(l => printer.text(l.trim()));

            printer.text('-'.repeat(WIDTH_NORMAL));
            printer.text('Sistema: sebasxs.com/smartpos');
            printer.feed(3);
            printer.cut();

            logger.info('Print job completed', { jobId });
            setTimeout(() => {
               try {
                  printer.close();
                  resolve();
               } catch (e) {
                  resolve();
               }
            }, 300);
         } catch (printErr) {
            logger.error('Print job failed', {
               jobId,
               error: printErr.message,
               stack: printErr.stack,
            });
            try {
               if (printer) printer.close();
            } catch (e) {}
            reject(printErr);
         }
      });
   });
};

const printTicketSafe = async (jobId, data) => {
   const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
         () => reject(new Error('Printer Timeout - Printer does not respond')),
         PRINTER_TIMEOUT,
      ),
   );

   try {
      await Promise.race([performPrint(jobId, data), timeoutPromise]);
      await updateJobStatus(jobId, 'printed');
   } catch (error) {
      logger.error('Job processing failed', { jobId, error: error.message, stack: error.stack });
      await updateJobStatus(jobId, 'error');
   }
};

let isPrinting = false;
const queue = [];

const processQueue = async () => {
   if (isPrinting || queue.length === 0) return;

   isPrinting = true;
   const job = queue.shift();

   try {
      await printTicketSafe(job.id, job.payload);
      await new Promise(r => setTimeout(r, 2000));
   } catch (e) {
      logger.error('Queue processing failed', { error: e.message, stack: e.stack });
   } finally {
      isPrinting = false;
      processQueue();
   }
};

const addToQueue = (id, payload) => {
   logger.info('Job added to queue', { jobId: id });
   queue.push({ id, payload });
   processQueue();
};

logger.info('Printer agent starting');

const processPending = async () => {
   try {
      const { data, error } = await supabase.from('print_jobs').select('*').eq('status', 'pending');
      if (error) throw error;
      if (data && data.length > 0) {
         logger.info('Enqueueing pending jobs', { count: data.length });
         data.forEach(job => addToQueue(job.id, job.payload));
      }
   } catch (e) {
      logger.error('Failed to fetch pending jobs', { error: e.message, stack: e.stack });
   }
};

processPending();

let myChannel = null;

const setupListener = async () => {
   logger.info('Starting Supabase realtime listener');

   if (myChannel) {
      try {
         await supabase.removeChannel(myChannel);
      } catch (e) {
         logger.warn('Error removing old channel', e);
      }
      myChannel = null;
   }

   myChannel = supabase
      .channel('print_jobs_realtime')
      .on(
         'postgres_changes',
         { event: 'INSERT', schema: 'public', table: 'print_jobs' },
         payload => {
            if (payload.new.status === 'pending') {
               addToQueue(payload.new.id, payload.new.payload);
            }
         },
      )
      .subscribe(status => {
         logger.info('Realtime socket status changed', { status });

         if (status === 'SUBSCRIBED') {
            logger.info('Connected to Realtime successfully');
            processPending();
         }

         if (status === 'CHANNEL_ERROR') {
            logger.error('Critical Realtime error, scheduling restart', {
               status,
               retryDelay: '10s',
            });

            setTimeout(() => {
               setupListener();
            }, 10_000);
         }
      });
};

setupListener();

process.on('uncaughtException', err => {
   logger.error('Uncaught exception', { error: err.message, stack: err.stack });
   setTimeout(() => {
      process.exit(1);
   }, 1000);
});
process.on('unhandledRejection', reason => {
   logger.error('Unhandled rejection', { reason: reason?.message || reason, stack: reason?.stack });
});

setInterval(processPending, 5 * 60 * 1000);
