const Service = require('node-windows').Service;
const path = require('path');

const svc = new Service({
   name: 'smartpos_printer',
   description: 'Automatic printing service for Smart POS Web.',
   script: path.join(__dirname, '..', 'src', 'index.js'),
   nodeOptions: ['--harmony'],
   execPath: path.join(__dirname, 'node.exe'),
   workingDirectory: path.join(__dirname, '..'),
});

svc.on('install', function () {
   console.log('✅ Service installed successfully.');
   console.log('🚀 Starting service...');
   svc.start();
});

svc.on('alreadyinstalled', function () {
   console.log('⚠️ The service was already installed.');
   console.log('Attempting to start...');
   svc.start();
});

svc.on('start', function () {
   console.log('⚡ The service has started and is running in the background.');
});

svc.install();
