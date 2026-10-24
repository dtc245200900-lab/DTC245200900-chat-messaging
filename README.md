# Hệ thống Chat / Messaging đơn giản

Ứng dụng chat nội bộ Node.js, Socket.IO, PostgreSQL, Nginx, pgAdmin, Prometheus, Grafana, Loki và Promtail.

## Khởi chạy

1. Sao chép `.env.example` thành `.env`. Tạo mật khẩu ngẫu nhiên riêng cho tài khoản bootstrap PostgreSQL, tài khoản ứng dụng, PostgreSQL exporter, pgAdmin và Grafana; `DATABASE_URL` phải dùng `POSTGRES_APP_USER` và `POSTGRES_APP_PASSWORD`. Đặt `JWT_SECRET` ngẫu nhiên ít nhất 32 ký tự. Có thể tạo chuỗi an toàn với `node -p "require('crypto').randomBytes(48).toString('base64url')"`.
2. Chạy `docker compose up --build -d`.
3. Mở http://localhost, tạo tài khoản, tạo phòng; người khác có thể tham gia bằng ID phòng.

Grafana tại `/grafana/`; dashboard **Chat Messaging - Monitoring** được nạp tự động. pgAdmin bật bằng `docker compose --profile admin up -d pgadmin` và chỉ truy cập trên máy chủ tại http://localhost:5050; host DB trong pgAdmin là `db`. PostgreSQL không publish cổng host.

## Giám sát

Prometheus lấy metrics ứng dụng qua Nginx (`/metrics`), PostgreSQL qua `postgres-exporter`, và tài nguyên container qua cAdvisor. Grafana tự nạp datasource Prometheus/Loki cùng dashboard trong `monitoring/grafana/dashboards/`.

Sau khi cập nhật cấu hình, chạy:

```powershell
docker compose up -d --build
```

Khởi tạo volume PostgreSQL mới sẽ tạo riêng tài khoản bootstrap, tài khoản ứng dụng không có quyền superuser và tài khoản exporter chỉ có `pg_monitor`; schema thuộc sở hữu tài khoản ứng dụng. Volume database hiện có không bị xóa. Khi chuyển database cũ, sao lưu trước, đặt `POSTGRES_APP_USER`, `POSTGRES_APP_PASSWORD` và `DATABASE_URL`, rồi chuyển quyền sở hữu qua phiên quản trị cục bộ:

```powershell
docker compose stop app
docker compose exec -u postgres db psql -U postgres -d internal_chat
```

Trong psql, tạo role với cùng mật khẩu đã đặt trong `.env` (nhập mật khẩu an toàn bằng `\password`), đổi chủ database/schema, rồi chuyển các bảng và sequence hiện có:

```sql
CREATE ROLE chat_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password chat_runtime
ALTER DATABASE internal_chat OWNER TO chat_runtime;
ALTER SCHEMA public OWNER TO chat_runtime;
SELECT format('ALTER TABLE %I.%I OWNER TO chat_runtime', schemaname, tablename)
FROM pg_tables WHERE schemaname='public' AND tableowner='chat_app';
\gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO chat_runtime', n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='S' AND pg_get_userbyid(c.relowner)='chat_app';
\gexec
\q
```

Khởi động lại bằng `docker compose up -d --build`. Khi đổi `POSTGRES_EXPORTER_PASSWORD`, cập nhật mật khẩu role từ phiên quản trị PostgreSQL trước khi khởi động lại exporter.

Mở `/grafana/`, vào **Dashboards → Chat Messaging → Chat Messaging - Monitoring**. Dashboard hiển thị trạng thái scrape, HTTP requests, Socket.IO connections, CPU/RAM container và PostgreSQL.

## LogQL mẫu

Tên container Compose dùng dấu gạch ngang (`chat-messaging-app-1`), do đó dùng bộ lọc sau:

```logql
{container=~".*chat-messaging-app.*"} | json
{container=~".*chat-messaging-app.*"} |= "GET"
{container=~".*chat-messaging-app.*"} |= "POST"
```

## Ghi chú bảo mật

Các dịch vụ chạy với filesystem chỉ đọc, `no-new-privileges` và bỏ Linux capabilities không cần thiết; PostgreSQL chỉ ghi vào volume dữ liệu và vùng tạm. Mạng được chia riêng cho ứng dụng/database, proxy/Grafana và observability; chỉ Nginx công khai ứng dụng, còn pgAdmin và Prometheus chỉ bind vào localhost. cAdvisor không chạy privileged. Promtail truy cập Docker API qua socket proxy chỉ cho phép các thao tác đọc container cần thiết, không mount Docker socket trực tiếp.

Nginx và Helmet bật các security headers, giới hạn request và cho phép micro/camera chỉ trên cùng origin. Cấu hình mẫu dùng HTTP cho máy phát triển; triển khai ra Internet cần HTTPS/TLS và `COOKIE_SECURE=true`. Đừng dùng chung hoặc giữ mật khẩu mẫu; sao lưu `.env` an toàn và không commit file này.

Sau khi sửa `JWT_SECRET`, dựng lại ứng dụng để vô hiệu hóa các session cũ:

```powershell
docker compose up -d --build --force-recreate app
```

Bản demo hỗ trợ đăng nhập bcrypt/JWT cookie HttpOnly, hồ sơ cá nhân gồm ảnh đại diện, tên hiển thị, chức vụ, phòng ban và giới thiệu; kết bạn bằng lời mời, chỉ trở thành bạn khi người nhận chấp nhận. Ngoài ra còn có nhóm công khai/riêng tư, chia sẻ tệp tối đa 100 MB (bao gồm các định dạng ảnh/video được trình duyệt nhận diện), tìm kiếm lịch sử trò chuyện, đổi mật khẩu và chat realtime. Thành viên đang trực tuyến trong cùng phòng có thể gọi thoại hoặc video bằng WebRTC; cần cấp quyền micro/camera và dùng HTTPS khi triển khai ngoài localhost. Cấu hình STUN mặc định hỗ trợ kết nối trực tiếp; mạng hạn chế NAT có thể cần TURN riêng. Trong từng phòng có thể tìm kiếm tin nhắn/phòng/thành viên, lọc và đánh dấu yêu thích, xem tệp, quản lý thành viên là bạn bè, tạo và cập nhật nhiệm vụ, lưu ghi chú chung, lên lịch họp, ghim tin nhắn và thả cảm xúc. Ứng dụng tự chạy migration trong `db/migrations/` khi khởi động để cập nhật database hiện có; không cần xóa volume. `db/init.sql` chỉ chạy khi tạo volume mới. App chạy non-root, read-only; networks DB/observability tách biệt. Triển khai Internet cần HTTPS, COOKIE_SECURE=true, khóa trang quản trị và backup.
