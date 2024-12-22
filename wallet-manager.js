// Constantes de la API
const URL = 'http://127.0.0.1:5000/';
const ADMIN_KEY = 'c139f21ff43c4e55b66a57877aeb48e2';
const INVOICE_KEY = 'c8e9b3e13a3846d68c100b9a0d8b3054';

// Elementos del DOM
const addWalletBtn = document.getElementById('addWalletBtn');
const addWalletModal = document.getElementById('addWalletModal');
const scanQrBtn = document.getElementById('scanQrBtn');
const manualInputBtn = document.getElementById('manualInputBtn');
const manualInput = document.getElementById('manualInput');
const walletUrl = document.getElementById('walletUrl');
const submitUrlBtn = document.getElementById('submitUrlBtn');
const cancelAddBtn = document.getElementById('cancelAddBtn');
const scannerModal = document.getElementById('scannerModal');
const nameWalletModal = document.getElementById('nameWalletModal');
const toggleCameraBtn = document.getElementById('toggleCameraBtn');
const cancelScanBtn = document.getElementById('cancelScanBtn');
const saveWalletBtn = document.getElementById('saveWalletBtn');
const cancelNameBtn = document.getElementById('cancelNameBtn');
const walletsList = document.getElementById('walletsList');
const mainBalance = document.getElementById('mainBalance');
const sendAmount = document.getElementById('sendAmount');
const destinationWallets = document.getElementById('destinationWallets');
const selectAllWallets = document.getElementById('selectAllWallets');
const sendSatsBtn = document.getElementById('sendSatsBtn');

// Variables para el escáner
const video = document.createElement("video");
const canvasElement = document.getElementById("qr-canvas");
const canvas = canvasElement.getContext("2d");
let scanning = false;

// Almacenamiento local de wallets
let registeredWallets = JSON.parse(localStorage.getItem('registeredWallets')) || [];

// Funciones de la API
async function fetchData(action, type, key, body) {
    const response = await fetch(URL + 'api/v1/' + action, {
        method: type,
        headers: {
            "X-Api-Key": key,
            "Content-Type": "application/json"
        },
        body: type !== 'GET' ? JSON.stringify(body) : undefined
    });
    return await response.json();
}

async function getWalletBalance() {
    const data = await fetchData('wallet', 'GET', INVOICE_KEY);
    return data.balance;
}

// Función para validar el tipo de código escaneado
async function validatePaymentCode(code) {
    try {
        // Limpiar el código de espacios y saltos de línea
        code = code.trim();
        
        // Detectar y limpiar prefijo de LNBits si existe
        if (code.includes("lightning=")) {
            code = code.split("lightning=")[1];
        }

        // Validar si es LNURL
        if (code.toLowerCase().startsWith('lnurl')) {
            return { type: 'LNURL', code };
        } 
        // Validar si es un invoice Lightning
        else if (code.toLowerCase().startsWith('lnbc')) {
            return { type: 'INVOICE', code };
        } 
        // Si no tiene prefijo lightning= ni es LNURL, verificar si es un invoice válido
        else {
            // Intentar validar como invoice sin prefijo
            if (/^[a-zA-Z0-9]*$/.test(code)) {
                return { type: 'INVOICE', code };
            }
            throw new Error('Código QR no válido');
        }
    } catch (error) {
        throw new Error('Error al validar el código: ' + error.message);
    }
}

// Función para pagar un invoice
async function payInvoice(bolt11) {
    try {
        // Decodificar el invoice para mostrar el monto
        const decodedInvoice = await fetchData('payments/decode', 'POST', ADMIN_KEY, {
            data: bolt11
        });

        const amount = decodedInvoice.amount_msat / 1000;
        
        // Confirmar el pago con el usuario
        if (!confirm(`¿Deseas pagar este invoice por ${amount} sats?`)) {
            return false;
        }

        // Realizar el pago
        const paymentResult = await fetchData('payments', 'POST', ADMIN_KEY, {
            out: true,
            bolt11: bolt11
        });

        if (paymentResult.payment_hash) {
            alert('Pago realizado con éxito');
            updateMainBalance();
            return true;
        } else {
            throw new Error('Error al procesar el pago');
        }
    } catch (error) {
        console.error('Error al pagar invoice:', error);
        alert('Error al realizar el pago: ' + error.message);
        return false;
    }
}

// Función para decodificar LNURL
async function decodeLNURL(lnurl) {
    try {
        if (lnurl.toLowerCase().startsWith('lnurl')) {
            const decoded = bech32.decode(lnurl, 2000);
            const words = decoded.words;
            const data = bech32.fromWords(words);
            const url = new TextDecoder().decode(new Uint8Array(data));
            return url;
        }
        return lnurl;
    } catch (error) {
        console.error('Error decodificando LNURL:', error);
        throw new Error('LNURL inválido');
    }
}

// Función para pagar usando LNURL
async function payLNURL(lnurl, amount) {
    try {
        const decodedUrl = await decodeLNURL(lnurl);
        
        // Obtener los detalles del endpoint LNURL-pay
        const response = await fetch(decodedUrl);
        const lnurlData = await response.json();
        
        if (lnurlData.status === 'ERROR') {
            throw new Error(lnurlData.reason || 'Error en LNURL-pay');
        }

        // Verificar que el monto está dentro de los límites
        const minSats = lnurlData.minSendable / 1000;
        const maxSats = lnurlData.maxSendable / 1000;
        if (amount < minSats || amount > maxSats) {
            throw new Error(`El monto debe estar entre ${minSats} y ${maxSats} sats`);
        }

        // Obtener la factura del callback
        const callbackUrl = new URL(lnurlData.callback);
        callbackUrl.searchParams.append('amount', amount * 1000);
        if (lnurlData.commentAllowed && lnurlData.commentAllowed > 0) {
            callbackUrl.searchParams.append('comment', 'Pago desde Wallet Manager');
        }

        const invoiceResponse = await fetch(callbackUrl.toString());
        const invoiceData = await invoiceResponse.json();

        if (!invoiceData.pr) {
            throw new Error('No se pudo obtener la factura');
        }

        // Pagar la factura
        const paymentResult = await fetchData('payments', 'POST', ADMIN_KEY, {
            out: true,
            bolt11: invoiceData.pr
        });

        return paymentResult;
    } catch (error) {
        console.error('Error en el pago LNURL:', error);
        throw error;
    }
}

// Funciones del escáner QR
function startCamera() {
    navigator.mediaDevices
        .getUserMedia({ video: { facingMode: "environment" } })
        .then(function(stream) {
            scanning = true;
            video.setAttribute("playsinline", true);
            video.srcObject = stream;
            video.play();
            tick();
            scan();
            toggleCameraBtn.textContent = 'Detener Cámara';
        });
}

function stopCamera() {
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
    }
    scanning = false;
    toggleCameraBtn.textContent = 'Activar Cámara';
}

function tick() {
    if (canvasElement.hidden) return;
    canvasElement.height = video.videoHeight;
    canvasElement.width = video.videoWidth;
    canvas.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);
    scanning && requestAnimationFrame(tick);
}

function scan() {
    try {
        qrcode.decode();
    } catch (e) {
        scanning && setTimeout(scan, 300);
    }
}

// Callback del escáner QR modificado para manejar ambos tipos de códigos
qrcode.callback = async (result) => {
    if (result) {
        document.getElementById('audioScaner').play();
        stopCamera();
        scannerModal.classList.add('hidden');

        try {
            const validationResult = await validatePaymentCode(result);
            
            if (validationResult.type === 'INVOICE') {
                // Si es un invoice, intentar pagarlo inmediatamente
                await payInvoice(validationResult.code);
            } else if (validationResult.type === 'LNURL') {
                // Si es un LNURL, mostrar modal para nombrarlo y guardarlo
                showNameWalletModal(validationResult.code);
            }
        } catch (error) {
            alert(error.message);
        }
    }
};


// Funciones de UI
function truncateAddress(address, maxLength = 20) {
    if (address.length <= maxLength) return address;
    return address.substring(0, maxLength / 2) + '...' + address.substring(address.length - maxLength / 2);
}

function updateWalletsList() {
    walletsList.innerHTML = '';
    destinationWallets.innerHTML = '';
    
    registeredWallets.forEach((wallet, index) => {
        const walletElement = document.createElement('div');
        walletElement.className = 'bg-gray-700 p-3 rounded flex justify-between items-center';
        walletElement.innerHTML = `
            <div class="flex-1 mr-4">
                <p class="font-bold">${wallet.name}</p>
                <p class="text-sm text-gray-400 truncate" title="${wallet.address}">
                    ${truncateAddress(wallet.address)}
                </p>
            </div>
            <button onclick="removeWallet(${index})" class="text-red-500 hover:text-red-600 flex-shrink-0">
                Eliminar
            </button>
        `;
        walletsList.appendChild(walletElement);

        const checkboxDiv = document.createElement('div');
        checkboxDiv.className = 'flex items-center';
        checkboxDiv.innerHTML = `
            <input type="checkbox" class="wallet-checkbox mr-2" value="${wallet.address}">
            <span>${wallet.name}</span>
        `;
        destinationWallets.appendChild(checkboxDiv);
    });
}

function showAddWalletModal() {
    addWalletModal.classList.remove('hidden');
    manualInput.classList.add('hidden');
}

function showNameWalletModal(address) {
    document.getElementById('walletAddress').value = address;
    document.getElementById('walletName').value = '';
    nameWalletModal.classList.remove('hidden');
}

function removeWallet(index) {
    registeredWallets.splice(index, 1);
    localStorage.setItem('registeredWallets', JSON.stringify(registeredWallets));
    updateWalletsList();
}

async function updateMainBalance() {
    const balance = await getWalletBalance();
    mainBalance.textContent = `${balance / 1000} SATS`;
}

function getSelectedWallets() {
    return Array.from(document.querySelectorAll('.wallet-checkbox:checked'))
        .map(checkbox => ({
            address: checkbox.value,
            name: checkbox.nextElementSibling.textContent
        }));
}

// Event Listeners
addWalletBtn.addEventListener('click', showAddWalletModal);

scanQrBtn.addEventListener('click', () => {
    addWalletModal.classList.add('hidden');
    scannerModal.classList.remove('hidden');
});

manualInputBtn.addEventListener('click', () => {
    manualInput.classList.toggle('hidden');
});

submitUrlBtn.addEventListener('click', async () => {
    const code = walletUrl.value.trim();
    if (code) {
        try {
            const validationResult = await validatePaymentCode(code);
            
            if (validationResult.type === 'INVOICE') {
                addWalletModal.classList.add('hidden');
                await payInvoice(validationResult.code);
            } else if (validationResult.type === 'LNURL') {
                addWalletModal.classList.add('hidden');
                showNameWalletModal(validationResult.code);
            }
            walletUrl.value = '';
        } catch (error) {
            alert(error.message);
        }
    } else {
        alert('Por favor ingrese un código válido');
    }
});

cancelAddBtn.addEventListener('click', () => {
    addWalletModal.classList.add('hidden');
    manualInput.classList.add('hidden');
    walletUrl.value = '';
});

toggleCameraBtn.addEventListener('click', () => {
    if (scanning) {
        stopCamera();
    } else {
        startCamera();
    }
});

cancelScanBtn.addEventListener('click', () => {
    stopCamera();
    scannerModal.classList.add('hidden');
});

saveWalletBtn.addEventListener('click', () => {
    const address = document.getElementById('walletAddress').value;
    const name = document.getElementById('walletName').value;
    
    if (!name) {
        alert('Por favor ingresa un nombre para la wallet');
        return;
    }

    registeredWallets.push({ name, address });
    localStorage.setItem('registeredWallets', JSON.stringify(registeredWallets));
    nameWalletModal.classList.add('hidden');
    updateWalletsList();
});

cancelNameBtn.addEventListener('click', () => {
    nameWalletModal.classList.add('hidden');
});

selectAllWallets.addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.wallet-checkbox');
    checkboxes.forEach(checkbox => checkbox.checked = e.target.checked);
});

// Manejar el envío de SATS a múltiples wallets
sendSatsBtn.addEventListener('click', async () => {
    const amount = parseInt(sendAmount.value);
    const selectedWallets = getSelectedWallets();

    if (!amount || selectedWallets.length === 0) {
        alert('Por favor ingresa un monto y selecciona al menos una wallet');
        return;
    }

    try {
        for (const wallet of selectedWallets) {
            console.log(`Iniciando pago a ${wallet.name}...`);
            await payLNURL(wallet.address, amount);
            console.log(`Pago exitoso a ${wallet.name}`);
        }
        
        alert('Pagos completados exitosamente');
        updateMainBalance();
        sendAmount.value = '';
        selectAllWallets.checked = false;
        const checkboxes = document.querySelectorAll('.wallet-checkbox');
        checkboxes.forEach(checkbox => checkbox.checked = false);
    } catch (error) {
        alert(`Error al realizar los pagos: ${error.message}`);
        console.error('Error en pagos:', error);
    }
});

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    updateWalletsList();
    updateMainBalance();
    
});
