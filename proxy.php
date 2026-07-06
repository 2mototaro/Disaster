<?php
header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json; charset=utf-8');

$lat = $_GET['lat'] ?? null;
$lon = $_GET['lon'] ?? $_GET['lng'] ?? null;

if (!$lat || !$lon) {
    echo json_encode(["error" => "Missing coordinates"]);
    exit;
}

$url = "https://nominatim.openstreetmap.org/reverse?format=json&lat=$lat&lon=$lon&zoom=10";

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);
// สำคัญมาก: เปลี่ยน User-Agent เป็นชื่อเฉพาะของคุณเอง (ห้ามใช้ค่าว่าง)
curl_setopt($ch, CURLOPT_USERAGENT, 'MyDisasterMapProject/1.0 (your-email@example.com)');
// ปิดการตรวจสอบ SSL ชั่วคราวถ้า Server มีปัญหาเรื่อง Certificate
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error = curl_error($ch);
curl_close($ch);

if ($httpCode === 200) {
    echo $response;
} else {
    echo json_encode([
        "error" => "OSM Error",
        "http_code" => $httpCode,
        "curl_error" => $error,
        "province" => "ไม่ระบุจังหวัด"
    ]);
}
?>