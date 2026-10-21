import cv2
import json
import time
import re
import os
import base64
import numpy as np
import paho.mqtt.client as mqtt
from datetime import datetime
from ultralytics import YOLO

# ==========================================    
# 1. CẤU HÌNH CÁC THƯ MỤC LƯU ẢNH
# ==========================================
BASE_DIR = "saved_plates"
DIR_ENTRY = os.path.join(BASE_DIR, "entry")
DIR_EXIT = os.path.join(BASE_DIR, "exit")
DIR_MASTER = os.path.join(BASE_DIR, "master")

# Tự động tạo 3 thư mục nếu chưa tồn tại
for folder in [DIR_ENTRY, DIR_EXIT, DIR_MASTER]:
    if not os.path.exists(folder):
        os.makedirs(folder)

# ==========================================    
# 2. CẤU HÌNH MQTT BROKER
# ==========================================
BROKER = "broker.emqx.io"
PORT = 1883

TOPIC_CAM_ENTRY  = "pbl5/cam/entry"
TOPIC_CAM_EXIT   = "pbl5/cam/exit"
TOPIC_CAM_MASTER = "pbl5/cam/master"

TOPIC_CTRL_ENTRY     = "pbl5/control/entry"
TOPIC_CTRL_EXIT      = "pbl5/control/exit"
TOPIC_NOTIFY         = "pbl5/master/notify"
TOPIC_PARKING_STATUS = "pbl5/parking/status"
TOPIC_GATE_EVENT     = "pbl5/gate/event"

mqtt_client = mqtt.Client(
    callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    transport="tcp"
)

# ==========================================
# 3. TẢI MÔ HÌNH YOLOV8 & XỬ LÝ BIỂN SỐ XE
# ==========================================
print("-> Đang tải mô hình YOLOv8 nhận diện ký tự (best.pt)...")
model = YOLO("best.pt")

CHAR_TO_NUM = {'O': '0', 'D': '0', 'Q': '0', 'I': '1', 'L': '1', 'Z': '2', 'S': '5', 'G': '6', 'B': '8', 'E': '6'}
NUM_TO_CHAR = {'0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B'}

def fix_vietnam_plate_rules(raw_str):
    """Sửa lỗi ký tự trùng lặp dựa trên quy tắc biển số xe Việt Nam"""
    clean = re.sub(r'[^A-Z0-9]', '', raw_str.upper())
    if len(clean) < 6: return clean
    chars = list(clean)
    
    # 2 ký tự đầu là mã tỉnh -> Phải là số
    for i in range(2):
        if chars[i] in CHAR_TO_NUM: 
            chars[i] = CHAR_TO_NUM[chars[i]]
            
    # Ký tự thứ 3 là sê-ri đăng ký -> Phải là chữ
    if len(chars) > 2 and chars[2] in NUM_TO_CHAR: 
        chars[2] = NUM_TO_CHAR[chars[2]]
        
    start_num_idx = 3
    if len(chars) >= 8 and chars[3].isalpha() and chars[3] not in ['I', 'O']: 
        start_num_idx = 4
        
    # Các ký tự còn lại là dãy số thứ tự
    for i in range(start_num_idx, len(chars)):
        if chars[i] in CHAR_TO_NUM: 
            chars[i] = CHAR_TO_NUM[chars[i]]
            
    return "".join(chars)[:9]

def extract_license_plate(results):
    """Trích xuất và sắp xếp các ký tự nhận dạng từ kết quả YOLOv8"""
    chars_list = []
    for result in results:
        for box in result.boxes:
            chars_list.append({
                'x': box.xyxy[0][0].item(), 
                'y': box.xyxy[0][1].item(),
                'h': box.xyxy[0][3].item() - box.xyxy[0][1].item(),
                'char': model.names[int(box.cls[0].item())]
            })

    if not chars_list: return ""
    
    avg_h = sum(c['h'] for c in chars_list) / len(chars_list)
    min_y, max_y = min(c['y'] for c in chars_list), max(c['y'] for c in chars_list)

    # Phân loại biển 2 dòng hay 1 dòng dựa trên tọa độ y
    if (max_y - min_y) > (avg_h * 0.6):
        mid_y = (min_y + max_y) / 2.0
        top = sorted([c for c in chars_list if c['y'] < mid_y], key=lambda c: c['x'])
        bot = sorted([c for c in chars_list if c['y'] >= mid_y], key=lambda c: c['x'])
        raw_plate = "".join([c['char'] for c in top]) + "".join([c['char'] for c in bot])
    else:
        chars_list.sort(key=lambda c: c['x'])
        raw_plate = "".join([c['char'] for c in chars_list])

    return fix_vietnam_plate_rules(raw_plate)

def send_master_notify(line1, line2, track=0):
    """Gửi thông báo tới Node 3 (OLED + Còi/Âm thanh DFPlayer)"""
    payload = json.dumps({"line1": line1, "line2": line2, "track": track})
    mqtt_client.publish(TOPIC_NOTIFY, payload)

# ==========================================
# 4. LUỒNG XỬ LÝ ẢNH
# ==========================================
def process_gate_image(image_np, gate_type):
    """Xử lý nhận diện biển số cổng Vào (Entry) và Ra (Exit)"""
    try:
        frame = cv2.imdecode(image_np, cv2.IMREAD_COLOR)
        if frame is None: return
        
        # Lật ảnh nếu góc quay camera bị ngược
        frame = cv2.flip(frame, -1)

        # Chạy mô hình YOLOv8
        results = model(frame, conf=0.25, verbose=False)
        detected_text = extract_license_plate(results)

        save_folder = DIR_ENTRY if gate_type == "entry" else DIR_EXIT
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        if len(detected_text) >= 6:
            print(f"\n🎯 [BIỂN SỐ NHẬN DIỆN - {gate_type.upper()}]: {detected_text}")

            # Vẽ bounding box và biển số lên ảnh
            annotated_img = results[0].plot()
            cv2.putText(annotated_img, detected_text, (30, 50), 
                        cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 0), 3)

            # Lưu ảnh đã vẽ nhận diện vào thư mục
            file_name = f"{timestamp}_{detected_text}.jpg"
            file_path = os.path.join(save_folder, file_name)
            cv2.imwrite(file_path, annotated_img)
            print(f"📁 Đã lưu ảnh vào: {file_path}")

                       # 1. Thông báo hiển thị OLED & Phát âm thanh Track 2 trên Node Master trước
            msg_line1 = "MOI VAO:" if gate_type == "entry" else "TAM BIET:"
            track_id = 2 if gate_type == "entry" else 4

            send_master_notify(msg_line1, detected_text, track=track_id)

            time.sleep(0.2)  # Chờ 200ms để Master kịp xử lý audio

            # 2. Gửi lệnh MỞ BARRIER chuẩn dạng "OPEN"
            target_ctrl = TOPIC_CTRL_ENTRY if gate_type == "entry" else TOPIC_CTRL_EXIT
            mqtt_client.publish(target_ctrl, "OPEN")

            # 3. Cập nhật sự kiện cổng lên Dashboard Web
            event_payload = json.dumps({
                "gate": gate_type,
                "plate": detected_text,
                "is_violation": False
            })

            print(f"→ Đang publish GATE_EVENT: {event_payload}")
            result = mqtt_client.publish(TOPIC_GATE_EVENT, event_payload, qos=1)
            print(f"→ Publish rc: {result.rc}")
            print(f"→ Message ID: {result.mid}")   # 0 = thành công
            result.wait_for_publish(timeout=5)

            print(f"→ Đã hoàn tất gửi: {result.is_published()}")

        else:
            # Lưu ảnh lỗi nếu không nhận diện được
            file_name = f"{timestamp}_UNKNOWN.jpg"
            file_path = os.path.join(save_folder, file_name)
            cv2.imwrite(file_path, frame)
            
            print(f"⚠️ Trạm {gate_type}: Không đủ ký tự hợp lệ! Đã lưu ảnh lỗi: {file_path}")
            send_master_notify("KHONG HOP LE!", "THU LAI", 3)

    except Exception as e:
        print(f"❌ Lỗi xử lý AI Cổng {gate_type}: {e}")

def process_master_parking_image(image_np):
    """Xử lý ảnh toàn cảnh 5 ô đỗ từ Camera Master"""
    try:
        frame = cv2.imdecode(image_np, cv2.IMREAD_COLOR)
        if frame is None: return
        
        # Lưu ảnh giám sát toàn cảnh vào saved_plates/master
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        file_name = f"{timestamp}_overview.jpg"
        file_path = os.path.join(DIR_MASTER, file_name)
        cv2.imwrite(file_path, frame)
        print(f"📸 [MASTER AI] Đã lưu ảnh toàn cảnh bãi đỗ vào: {file_path}")

    except Exception as e:
        print(f"❌ Lỗi xử lý ảnh Master: {e}")

# ==========================================
# 5. CALLBACK MQTT
# ==========================================
def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        print("-> [MQTT] Kết nối thành công EMQX Broker!")
        client.subscribe([(TOPIC_CAM_ENTRY, 0), (TOPIC_CAM_EXIT, 0), (TOPIC_CAM_MASTER, 0)])
    else:
        print(f"-> Lỗi kết nối MQTT, Mã lỗi: {rc}")

def on_message(client, userdata, msg):
    try:
        base64_data = msg.payload.decode('utf-8')
        img_bytes = base64.b64decode(base64_data)
        img_as_np = np.frombuffer(img_bytes, dtype=np.uint8)

        if msg.topic == TOPIC_CAM_ENTRY:
            process_gate_image(img_as_np, "entry")
        elif msg.topic == TOPIC_CAM_EXIT:
            process_gate_image(img_as_np, "exit")
        elif msg.topic == TOPIC_CAM_MASTER:
            process_master_parking_image(img_as_np)
            
    except Exception as e:
        print(f"❌ Lỗi giải mã dữ liệu Base64 từ topic {msg.topic}: {e}")

# ==========================================
# 6. KHỞI CHẠY LẮNG NGHE SERVER
# ==========================================
mqtt_client.on_connect = on_connect
mqtt_client.on_message = on_message

try:
    mqtt_client.connect(BROKER, PORT, keepalive=60)
except Exception as e:
    print(f"❌ Không kết nối được Broker: {e}")

print("🚀 Hệ thống AI Server 3-Node (YOLOv8) đã sẵn sàng...")
mqtt_client.loop_forever()