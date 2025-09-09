require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const usb = require('usb');
if (!usb.on) {
   usb.on = function () {};
   usb.removeListener = function () {};
}

const escpos = require('escpos');
escpos.USB = require('escpos-usb');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
   auth: { persistSession: false, autoRefreshToken: false },
});

const VID = 0x0493;
const PID = 0x8760;

const WIDTH_NORMAL = 48;
const WIDTH_DOUBLE = 24;
const LINE_DIVIDER = '-'.repeat(WIDTH_NORMAL);

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
   await supabase.from('print_jobs').update({ status: status }).eq('id', id);
};

const printTicket = (jobId, data) => {
   return new Promise(async resolve => {
      const device = new escpos.USB(VID, PID);
      const options = { encoding: 'cp850', width: WIDTH_NORMAL };
      const printer = new escpos.Printer(device, options);

      console.log(`🖨️  Job ID: ${jobId}`);

      device.open(async function (error) {
         if (error) {
            console.error('❌ Printer error:', error);
            await updateJobStatus(jobId, 'error');
            return resolve();
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
            data.items.forEach(item => {
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
            printer.close();

            console.log('✅ Job completed.');
            await updateJobStatus(jobId, 'printed');
            resolve();
         } catch (printErr) {
            console.error('🔥 Job error:', printErr);
            await updateJobStatus(jobId, 'error');
            try {
               printer.close();
            } catch (e) {}
            resolve();
         }
      });
   });
};

let isPrinting = false;
const queue = [];

const processQueue = async () => {
   if (isPrinting || queue.length === 0) return;

   isPrinting = true;
   const job = queue.shift();

   try {
      await printTicket(job.id, job.payload);

      await new Promise(r => setTimeout(r, 3000));
   } catch (e) {
      console.error('Error procesando cola:', e);
   } finally {
      isPrinting = false;
      processQueue();
   }
};

const addToQueue = (id, payload) => {
   console.log(`📥 Adding to queue: ID ${id}`);
   queue.push({ id, payload });
   processQueue();
};

// --- LISTENER ---
console.log('🚀 Printer Agent Starting...');

const processPending = async () => {
   const { data } = await supabase.from('print_jobs').select('*').eq('status', 'pending');
   if (data && data.length > 0) {
      console.log(`📦 Encolando ${data.length} pendientes...`);
      data.forEach(job => addToQueue(job.id, job.payload));
   }
};

processPending();

supabase
   .channel('print_jobs_realtime')
   .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'print_jobs' }, payload => {
      if (payload.new.status === 'pending') {
         addToQueue(payload.new.id, payload.new.payload);
      }
   })
   .subscribe();
