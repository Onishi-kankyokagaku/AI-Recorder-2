importScripts('https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.all.min.js');

const DB_NAME = 'AIRecorderDB';
const STORE_NAME = 'audioQueue';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'index' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveToLocal(item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function deleteFromLocal(index) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(index);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// リトライ付き fetch 関数
async function fetchWithRetry(url, options, maxRetries = 6, initialDelay = 3000) {
    let delay = initialDelay;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) {
                const json = await response.json();
                return json;
            }
            throw new Error(`HTTP Error: ${response.status}`);
        } catch (err) {
            if (attempt === maxRetries) throw err; // 6回失敗したら catch ブロックへ投げる
            
            self.postMessage({ status: 'retrying', attempt: attempt, maxRetries: maxRetries, error: err.message });
            await new Promise(r => setTimeout(r, delay));
            delay *= 1.5;
        }
    }
}

self.onmessage = async (e) => {
    const { type, gasUrl, ssId, index, logRow, floatArray, sampleRate } = e.data;

    // --- [初期化] ---
    if (type === 'init') {
        try {
            const result = await fetchWithRetry(gasUrl, {
                method: 'POST',
                body: JSON.stringify({ type: 'init' })
            }, 3, 2000);
            self.postMessage({ status: 'success', type: 'init', result: result });
        } catch (error) {
            self.postMessage({ status: 'error', type: 'init', error: error.message });
        }
        return; 
    }

    // --- [録音開始通知] ---
    if (type === 'recording') {
        try {
            await fetchWithRetry(gasUrl, {
                method: 'POST',
                body: JSON.stringify({ type: 'recording', logRow: logRow })
            }, 3, 2000);
            self.postMessage({ status: 'success', type: 'recording' });
        } catch (error) {
            self.postMessage({ status: 'error', type: 'recording', error: error.message });
        }
        return;
    }

    // --- [音声送信処理] ---
    if (!floatArray) {
        self.postMessage({ status: 'error', type: type, index: index, error: "音声データが空です" });
        return;
    }

    const mp3Data = encodeMP3(floatArray, sampleRate);
    const base64Audio = arrayBufferToBase64(mp3Data);

    const payload = {
        type: type,
        index: index,
        ssId: ssId,
        logRow: logRow,
        audio: base64Audio
    };

    // 1. まずローカル(IndexedDB)へ退避保存
    try {
        await saveToLocal(payload);
    } catch (dbErr) {
        console.warn("IndexedDB保存失敗:", dbErr);
    }

    // 2. GASへの送信を試みる
    try {
        const result = await fetchWithRetry(gasUrl, {
            method: 'POST',
            body: JSON.stringify(payload)
        }, 6, 3000);

        // ★送信に成功した場合のみ、ローカル保存データを消去する
        await deleteFromLocal(index);

        self.postMessage({ 
            status: 'success', 
            type: type, 
            index: index,
            result: result 
        });
    } catch (error) {
        // ★修正ポイント：6回のリトライが失敗した場合は、完全に通信諦めモードに入る。
        // GASへは何も送信せず、ローカル保存を残したままメインスレッドへ報告する。
        self.postMessage({ 
            status: 'warning_offline', 
            type: type, 
            index: index, 
            error: "通信障害のためGAS送信をスキップし、端末内に保存しました。" 
        });
    }
};

function encodeMP3(samples, sampleRate) {
    const mp3encoder = new lamejs.Mp3Encoder(1, sampleRate, 128);
    const mp3Data = [];
    const int16Samples = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        let s = Math.max(-1, Math.min(1, samples[i]));
        int16Samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const mp3Tmp = mp3encoder.encodeBuffer(int16Samples);
    if (mp3Tmp.length > 0) mp3Data.push(mp3Tmp);
    const mp3Exit = mp3encoder.flush();
    if (mp3Exit.length > 0) mp3Data.push(mp3Exit);
    let totalLength = 0;
    for (const buf of mp3Data) totalLength += buf.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of mp3Data) {
        result.set(buf, offset);
        offset += buf.length;
    }
    return result.buffer;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
