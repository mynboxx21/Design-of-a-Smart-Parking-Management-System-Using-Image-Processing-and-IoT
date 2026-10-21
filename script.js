// ==========================================
// 1. CẤU HÌNH TOPICS MQTT ĐỒNG BỘ TOÀN HỆ THỐNG
// ==========================================
const TOPIC_PARKING_STATUS = 'pbl5/parking/status';  // Trạng thái 5 ô đỗ từ AI Master
const TOPIC_GATE_EVENT     = 'pbl5/gate/event';       // Sự kiện xe qua cổng (Vào/Ra)
const TOPIC_CTRL_ENTRY     = 'pbl5/control/entry';    // Lệnh điều khiển cổng vào
const TOPIC_CTRL_EXIT      = 'pbl5/control/exit';     // Lệnh điều khiển cổng ra
const TOPIC_NOTIFY         = 'pbl5/master/notify';    // Gửi lệnh cảnh báo còi/đèn qua Master
const TOPIC_FIRE_STATUS = 'pbl5/master/fire_status';   

const TOTAL_SPOTS = 5;

// Kết nối Broker EMQX qua WebSocket an toàn (WSS: 8084)
const client = mqtt.connect('wss://broker.emqx.io:8084/mqtt');

// Trạng thái lưu trữ 5 ô đỗ
const spotsState = { 1: 'EMPTY', 2: 'EMPTY', 3: 'EMPTY', 4: 'EMPTY', 5: 'EMPTY' };

// Trạng thái thiết bị hệ thống
let systemState = {
    barrierOpen: false,
    barrierAuto: true,
    alarmActive: false
};

// ==========================================
// 2. LẮNG NGHE VÀ XỬ LÝ KẾT NỐI MQTT
// ==========================================
client.on('connect', () => {
    console.log('✅ MQTT Connected!');
    
    document.getElementById('mqtt-dot').className = 'w-3 h-3 rounded-full bg-emerald-500 animate-pulse';
    document.getElementById('mqtt-status').innerText = 'System Online (MQTT Connected)';
    document.getElementById('mqtt-status').className = 'text-xs font-semibold text-emerald-400';
    
    client.subscribe(TOPIC_PARKING_STATUS, (err) => {
        if (err) console.error('Subscribe PARKING_STATUS lỗi:', err);
        else console.log('✅ Subscribed:', TOPIC_PARKING_STATUS);
    });
    
    client.subscribe(TOPIC_GATE_EVENT, (err) => {
        if (err) console.error('Subscribe GATE_EVENT lỗi:', err);
        else console.log('✅ Subscribed:', TOPIC_GATE_EVENT);
    });

    
   client.subscribe(TOPIC_FIRE_STATUS, (err) => {
        if (err) console.error('Subscribe FIRE_STATUS lỗi:', err);
        else console.log('✅ Subscribed:', TOPIC_FIRE_STATUS);
    });

});

client.on('offline', () => {
    document.getElementById('mqtt-dot').className = 'w-3 h-3 rounded-full bg-red-500';
    document.getElementById('mqtt-status').innerText = 'Mất kết nối MQTT';
    document.getElementById('mqtt-status').className = 'text-xs font-semibold text-red-400';
});

// ==========================================
// 3. XỬ LÝ DỮ LIỆU NHẬN TỪ AI SERVER & ESP32
// ==========================================
client.on('message', (topic, message) => {
    console.log('📩 Nhận được message:', topic, message.toString());

    try {
        const data = JSON.parse(message.toString());

        // Xử lý trạng thái cảm biến lửa HW-484
        if (topic === TOPIC_FIRE_STATUS) {
            if (typeof data.fire_detected === 'boolean') {
                updateFireStatus(data.fire_detected);
                console.log(
                    '[FIRE WEB] Trạng thái:',
                    data.fire_detected ? 'PHÁT HIỆN LỬA' : 'AN TOÀN'
                );
            } else {
                console.warn('Dữ liệu trạng thái lửa không hợp lệ:', data);
            }
            return;
        }

        // 1. Nhận trạng thái Ô đỗ
        if (topic === TOPIC_PARKING_STATUS) {
            const spotId = data.spot_id;
            const status = data.status;
            const error = data.error || 'NONE';

            if (spotsState.hasOwnProperty(spotId)) {
                spotsState[spotId] = status;
                updateSpotUI(spotId, status, error);
                updateSummaryCards();
                
                if (status === 'VIOLATION') {
                    if (systemState.barrierAuto) {
                        triggerAlarmHardware(true);
                    }
                    addLogEntry(`BÃI ĐỖ - Ô ${spotId}`, `VI PHẠM: ${error}`, 'VIOLATION');
                } else {
                    addLogEntry(`BÃI ĐỖ - Ô ${spotId}`, `Trạng thái: ${status}`, 'NONE');
                }
            }
        }
        
        // 2. Nhận sự kiện Cổng Vào / Cổng Ra
        else if (topic === TOPIC_GATE_EVENT) {
            const gate = data.gate;
            const plate = data.plate || 'UNKNOWN';
            const isViolation = data.is_violation || false;

            if (gate === 'entry') {
                document.getElementById('entry-plate').innerText = plate;
                addLogEntry('CỔNG VÀO', `Xe ${plate} đã quét thành công`, 'NONE');
                
                if (systemState.barrierAuto) {
                    setBarrierUIState(true);
                    setTimeout(() => setBarrierUIState(false), 5000);
                }
            } 
            else if (gate === 'exit') {
                document.getElementById('exit-plate').innerText = plate;
                const violationText = document.getElementById('exit-violation-status');
                
                if (isViolation) {
                    violationText.innerText = `VI PHẠM ĐÈ VẠCH`;
                    violationText.className = 'text-xs font-bold text-red-500 animate-pulse';
                    triggerAlarmHardware(true);
                    addLogEntry('CỔNG RA', `Xe ${plate} VI PHẠM KHI XUẤT BÃI`, 'VIOLATION');
                } else {
                    violationText.innerText = 'KHÔNG VI PHẠM';
                    violationText.className = 'text-xs font-bold text-emerald-400';
                    addLogEntry('CỔNG RA', `Xe ${plate} xuất bãi hợp lệ`, 'NONE');
                }
            }
        }
    } catch (e) {
        console.error("Lỗi parse MQTT:", e);
    }
});
// ==========================================
// 4. HÀM CẬP NHẬT GIAO DIỆN Ô ĐỖ
// ==========================================
function updateSpotUI(spotId, status, error) {
    const card = document.getElementById(`spot-card-${spotId}`);
    const icon = document.getElementById(`spot-icon-${spotId}`);
    const text = document.getElementById(`spot-text-${spotId}`);
    const timeSpan = document.getElementById(`spot-time-${spotId}`);

    if (!card || !icon || !text || !timeSpan) return;

    timeSpan.innerText = `Cập nhật: ${new Date().toLocaleTimeString('vi-VN')}`;
    card.className = "rounded-xl p-4 flex flex-col items-center justify-between h-48 transition-all duration-300 ";

    if (status === 'EMPTY') {
        card.classList.add('bg-emerald-950/40', 'border-2', 'border-emerald-500');
        icon.className = "fa-solid fa-square-parking text-4xl text-emerald-500 mb-1";
        text.className = "text-sm font-bold text-emerald-400";
        text.innerText = "TRỐNG";
    } 
    else if (status === 'OCCUPIED') {
        card.classList.add('bg-blue-950/40', 'border-2', 'border-blue-500');
        icon.className = "fa-solid fa-car text-4xl text-blue-400 mb-1";
        text.className = "text-sm font-bold text-blue-400";
        text.innerText = "ĐÃ ĐỖ XE";
    } 
    else if (status === 'VIOLATION') {
        card.classList.add('bg-red-950/60', 'border-2', 'border-red-500', 'animate-pulse');
        icon.className = "fa-solid fa-triangle-exclamation text-4xl text-red-500 mb-1 animate-bounce";
        text.className = "text-sm font-bold text-red-500";
        text.innerText = `VI PHẠM (${error})`;
    }
}

function updateSummaryCards() {
    let emptyCount = 0, occupiedCount = 0, violationCount = 0;

    Object.values(spotsState).forEach(st => {
        if (st === 'EMPTY') emptyCount++;
        if (st === 'OCCUPIED') occupiedCount++;
        if (st === 'VIOLATION') violationCount++;
    });

    document.getElementById('stat-empty').innerText = emptyCount;
    document.getElementById('stat-occupied').innerText = occupiedCount;
    document.getElementById('stat-violation').innerText = violationCount;

    const lcdStatus = document.getElementById('entry-lcd-status');
    if (lcdStatus) {
        if (emptyCount > 0) {
            lcdStatus.innerText = `XIN CHÀO! CÒN TRỐNG ${emptyCount}/${TOTAL_SPOTS}`;
            lcdStatus.className = 'text-xs text-emerald-400 font-bold';
        } else {
            lcdStatus.innerText = 'BÃI ĐỖ ĐÃ ĐẦY!';
            lcdStatus.className = 'text-xs text-red-500 font-bold';
        }
    }
}

// ==========================================
// 5. ĐIỀU KIỂN THIẾT BỊ (ĐỒNG BỘ VỚI ESP32)
// ==========================================
function toggleBarrierManual() {
    const newState = !systemState.barrierOpen;
    setBarrierUIState(newState);
    
    // Gửi lệnh điều khiển chuẩn "OPEN_BARRIER" / "CLOSE_BARRIER" trực tiếp đến Node 1
    const command = newState ? "OPEN_BARRIER" : "CLOSE_BARRIER";
    client.publish(TOPIC_CTRL_ENTRY, command);
}

function setBarrierUIState(isOpen) {
    systemState.barrierOpen = isOpen;
    const badge = document.getElementById('barrier-status-badge');
    const icon = document.getElementById('barrier-icon');

    if (isOpen) {
        badge.innerText = "ĐANG MỞ";
        badge.className = "text-xs font-bold px-3 py-1 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500";
        icon.className = "fa-solid fa-road-barrier text-3xl text-emerald-400 rotate-45 transition-all";
    } else {
        badge.innerText = "ĐANG ĐÓNG";
        badge.className = "text-xs font-bold px-3 py-1 rounded bg-slate-700 text-slate-300 border border-slate-600";
        icon.className = "fa-solid fa-road-barrier text-3xl text-slate-400 transition-all";
    }
}

function toggleAutoBarrier() {
    systemState.barrierAuto = !systemState.barrierAuto;
    const btn = document.getElementById('btn-auto-barrier');
    if (systemState.barrierAuto) {
        btn.innerText = "Chế độ: TỰ ĐỘNG";
        btn.className = "text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 font-bold text-white transition";
    } else {
        btn.innerText = "Chế độ: THỦ CÔNG";
        btn.className = "text-xs px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 font-bold text-white transition";
    }
}

function triggerAlarmHardware(enable) {
    systemState.alarmActive = enable;
    const buzzerBtn = document.getElementById('btn-buzzer');
    
    if (enable) {
        buzzerBtn.className = "w-full py-2 rounded-lg font-bold text-xs bg-red-600 text-white animate-pulse";
        buzzerBtn.innerHTML = `<i class="fa-solid fa-volume-high"></i> CẢNH BÁO: ĐANG BẬT`;
        // Gửi thông báo còi hú (Audio Track 3) tới Node Master
        const payload = JSON.stringify({ line1: "CANH BAO!", line2: "VI PHAM VI TRI", track: 3 });
        client.publish(TOPIC_NOTIFY, payload);
    } else {
        buzzerBtn.className = "w-full py-2 rounded-lg font-bold text-xs bg-slate-700 text-slate-300 hover:bg-slate-600";
        buzzerBtn.innerHTML = `<i class="fa-solid fa-volume-xmark"></i> CẢNH BÁO: TẮT`;
        const payload = JSON.stringify({ line1: "SMART PARKING", line2: "SAN SANG", track: 0 });
        client.publish(TOPIC_NOTIFY, payload);
    }
}

// ==========================================
// 6. LOG NHẬT KÝ SỰ KIỆN
// ==========================================
function addLogEntry(source, status, type) {
    const container = document.getElementById('log-container');
    if (!container) return;

    if (container.children[0]?.innerText.includes('Chưa có sự kiện')) {
        container.innerHTML = '';
    }

    const time = new Date().toLocaleTimeString('vi-VN');
    const item = document.createElement('div');
    item.className = "p-3 rounded-lg bg-slate-900 border border-slate-700 text-xs flex justify-between items-center";

    item.innerHTML = `
        <div>
            <span class="font-bold text-slate-300">${source}</span>: 
            <span class="${type === 'VIOLATION' ? 'text-red-500 font-bold' : 'text-slate-300'}">${status}</span>
        </div>
        <span class="text-[10px] text-slate-500">${time}</span>
    `;

    container.insertBefore(item, container.firstChild);
}

function clearLogs() {
    document.getElementById('log-container').innerHTML = '<div class="text-xs text-slate-500 text-center py-8">Chưa có sự kiện mới.</div>';
}

//Phát hiện lửa
let fireDetected = null;

function updateFireStatus(detected) {
    const card = document.getElementById('fire-status-card');
    const icon = document.getElementById('fire-status-icon');
    const text = document.getElementById('fire-status-text');
    const detail = document.getElementById('fire-status-detail');
    const time = document.getElementById('fire-time');

    if (!card || !icon || !text || !detail || !time) return;

    // Chỉ ghi nhật ký khi trạng thái thay đổi
    const changed = fireDetected !== detected;
    fireDetected = detected;

    time.innerText = 'Cập nhật: ' + 
        new Date().toLocaleTimeString('vi-VN');

    if (detected) {
        card.className =
            'bg-red-950/60 border-2 border-red-500 rounded-lg p-4 flex items-center gap-4';

        icon.className =
            'fa-solid fa-fire-flame-curved text-3xl text-red-500 animate-pulse';

        text.className = 'font-bold text-red-400';
        text.innerText = 'CẢNH BÁO: PHÁT HIỆN LỬA';

        detail.innerText =
            'Cảm biến HW-484 đang phát hiện lửa. Kiểm tra khu vực ngay!';

        if (changed) {
            addLogEntry(
                'CẢM BIẾN LỬA',
                'PHÁT HIỆN LỬA',
                'VIOLATION'
            );
        }
    } else {
        card.className =
            'bg-emerald-950/40 border border-emerald-500 rounded-lg p-4 flex items-center gap-4';

        icon.className =
            'fa-solid fa-shield-halved text-3xl text-emerald-400';

        text.className = 'font-bold text-emerald-400';
        text.innerText = 'KHÔNG PHÁT HIỆN LỬA';

        detail.innerText =
            'Cảm biến đang báo không phát hiện lửa.';

        if (changed) {
            addLogEntry(
                'CẢM BIẾN LỬA',
                'Không phát hiện lửa',
                'NONE'
            );
        }
    }
}
