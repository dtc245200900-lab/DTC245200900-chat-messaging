# Hệ thống Chat / Messaging đơn giản

Ứng dụng chat nội bộ Node.js, Socket.IO, PostgreSQL, Nginx, pgAdmin, Prometheus, Grafana, Loki và Promtail.

## Khởi chạy

1. Sao chép `.env.example` thành `.env`; đổi toàn bộ mật khẩu mẫu và đặt JWT_SECRET ngẫu nhiên dài ít nhất 32 ký tự.
2. Chạy `docker compose up --build -d`.
3. Mở http://localhost, tạo tài khoản, tạo phòng; người khác có thể tham gia bằng ID phòng.

Grafana tại `/grafana/`; dashboard **Chat Messaging - Monitoring** được nạp tự động. pgAdmin bật bằng `docker compose --profile admin up -d pgadmin` và truy cập qua `/pgadmin/`; host DB trong pgAdmin là `db`. PostgreSQL không publish cổng host.

## Giám sát

Prometheus lấy metrics ứng dụng qua Nginx (`/metrics`), PostgreSQL qua `postgres-exporter`, và tài nguyên container qua cAdvisor. Grafana tự nạp datasource Prometheus/Loki cùng dashboard trong `monitoring/grafana/dashboards/`.

Sau khi cập nhật cấu hình, chạy:

```powershell
docker compose up -d --build
```

Lần đầu với database volume cũ, cấp quyền đọc thống kê PostgreSQL cho user ứng dụng một lần:

```powershell
docker compose exec db psql -U chat_app -d internal_chat -c "GRANT pg_monitor TO chat_app;"
```

Mở `/grafana/`, vào **Dashboards → Chat Messaging → Chat Messaging - Monitoring**. Dashboard hiển thị trạng thái scrape, HTTP requests, Socket.IO connections, CPU/RAM container và PostgreSQL.

## LogQL mẫu

Tên container Compose dùng dấu gạch ngang (`chat-messaging-app-1`), do đó dùng bộ lọc sau:

```logql
{container=~".*chat-messaging-app.*"} | json
{container=~".*chat-messaging-app.*"} |= "GET"
{container=~".*chat-messaging-app.*"} |= "POST"
```

## Ghi chú bảo mật

Ứng dụng chạy non-root, filesystem chỉ đọc, bỏ Linux capabilities và tách network database/observability; Nginx đặt security headers và giới hạn tốc độ API. cAdvisor cần quyền đọc thông tin host/container để xuất metrics; cấu hình demo cấp quyền privileged cho dịch vụ giám sát này, nên chỉ dùng trên máy lab.

Sau khi sửa `JWT_SECRET`, dựng lại ứng dụng để vô hiệu hóa các session cũ:

```powershell
docker compose up -d --build --force-recreate app
```

Bản demo gồm đăng nhập bcrypt/JWT cookie HttpOnly, phòng, join, lịch sử tin nhắn, socket realtime, rate limit và log JSON. App chạy non-root, read-only; networks DB/observability tách biệt. Triển khai Internet cần HTTPS, COOKIE_SECURE=true, khóa trang quản trị và backup. init.sql chỉ áp dụng trên volume mới.
