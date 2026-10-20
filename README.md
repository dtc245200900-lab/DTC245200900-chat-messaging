# Hệ thống chat nội bộ

Ứng dụng chat nhóm thời gian thực dùng Node.js, Socket.IO và PostgreSQL. Docker Compose triển khai ứng dụng cùng Nginx, pgAdmin, Prometheus, Grafana, cAdvisor, Loki và Promtail. Nginx là cổng truy cập web; PostgreSQL không mở cổng trực tiếp ra máy host.

## 1. Yêu cầu trước khi chạy

- Windows 10/11 và Docker Desktop đã cài đặt, đang chạy Linux containers.
- Git nếu muốn clone repository.
- Cổng `80` chưa bị ứng dụng khác chiếm. pgAdmin dùng cổng loopback `5050` khi bật profile `admin`.

Mở PowerShell tại thư mục chứa `docker-compose.yml`. Nếu clone từ GitHub:

```powershell
git clone https://github.com/dtc245200900-lab/DTC245200900-chat-messaging.git
Set-Location DTC245200900-chat-messaging
```

## 2. Cấu hình biến môi trường

Tạo `.env` từ file mẫu rồi mở để thay các giá trị mẫu:

```powershell
Copy-Item .env.example .env
notepad .env
```

Thay các giá trị cho `POSTGRES_PASSWORD`, `PGADMIN_DEFAULT_PASSWORD` và `GRAFANA_ADMIN_PASSWORD` bằng mật khẩu riêng, dài và ngẫu nhiên. Đặt `JWT_SECRET` thành chuỗi ngẫu nhiên tối thiểu 32 ký tự. Ví dụ tạo chuỗi an toàn bằng Node.js:

```powershell
node -p "require('crypto').randomBytes(32).toString('hex')"
```

Trong `.env`, `DATABASE_URL` phải dùng đúng username, mật khẩu và database đã khai báo ở `POSTGRES_USER`, `POSTGRES_PASSWORD` và `POSTGRES_DB`. File `.env` chứa bí mật, không gửi lên GitHub; chỉ commit `.env.example`.

Lưu ý khi đổi mật khẩu PostgreSQL sau lần chạy đầu: biến `POSTGRES_PASSWORD` chỉ khởi tạo mật khẩu khi volume database được tạo lần đầu; sửa `.env` không tự đổi mật khẩu trong volume cũ. Vào psql và dùng lệnh `\password chat_app` để đổi mật khẩu tương tác, sau đó cập nhật `POSTGRES_PASSWORD` và `DATABASE_URL` trong `.env`, rồi tạo lại app và exporter:

```powershell
docker compose exec db psql -U chat_app -d internal_chat
```

Trong dấu nhắc psql chạy `\password chat_app`, nhập mật khẩu mới hai lần, rồi thoát bằng `\q`. Dùng chuỗi ngẫu nhiên chỉ gồm chữ và số để dễ đặt trong `DATABASE_URL`.

## 3. Khởi động và dừng hệ thống

Kiểm tra cấu hình Compose và khởi động các dịch vụ chính:

```powershell
docker compose config -q
docker compose up -d --build
docker compose ps
```

pgAdmin nằm trong profile `admin`, nên khởi động riêng khi cần:

```powershell
docker compose --profile admin up -d pgadmin
docker compose ps
```

Để dừng container mà giữ lại database và dữ liệu dashboard:

```powershell
docker compose down
```

`docker compose down -v` sẽ xóa các named volumes, bao gồm dữ liệu PostgreSQL, Grafana và Loki. Chỉ dùng lệnh đó khi thực sự muốn xóa dữ liệu lab.

## 4. Truy cập và demo ứng dụng

| Thành phần | Địa chỉ | Tài khoản / lưu ý |
|---|---|---|
| Ứng dụng chat | `http://localhost/` | Tạo tài khoản, tạo phòng, chia sẻ ID phòng cho tài khoản thứ hai để tham gia và gửi tin nhắn. |
| Health endpoint | `http://localhost/health` | Phản hồi của ứng dụng được chuyển tiếp qua Nginx. |
| Grafana | `http://localhost/grafana/` | Username `admin`; mật khẩu là `GRAFANA_ADMIN_PASSWORD` trong `.env`. |
| pgAdmin qua Nginx | `http://localhost/pgadmin/` | Chỉ hoạt động sau khi bật profile `admin`. |
| pgAdmin trực tiếp | `http://127.0.0.1:5050/` | Chỉ bind vào loopback trên máy host. Đăng nhập bằng `PGADMIN_DEFAULT_EMAIL` và `PGADMIN_DEFAULT_PASSWORD`. |

Để chứng minh chat hoạt động, đăng nhập bằng hai tài khoản ở hai trình duyệt hoặc một cửa sổ ẩn danh. Tài khoản thứ nhất tạo phòng và gửi ID phòng; tài khoản thứ hai tham gia bằng ID đó. Gửi tin nhắn từ cả hai phía.

## 5. Kết nối PostgreSQL bằng pgAdmin

Sau khi đăng nhập pgAdmin, đăng ký server mới nếu cây Object Explorer chưa có server:

1. Chọn **Register → Server**.
2. Tab **General**: đặt tên tùy ý, ví dụ `Chat PostgreSQL`.
3. Tab **Connection** nhập:
   - **Host name/address:** `db`
   - **Port:** `5432`
   - **Maintenance database:** giá trị `POSTGRES_DB` trong `.env` (mặc định mẫu là `internal_chat`)
   - **Username:** giá trị `POSTGRES_USER` trong `.env` (mặc định mẫu là `chat_app`)
   - **Password:** giá trị `POSTGRES_PASSWORD` trong `.env`
4. Chọn **Save**, mở database → **Schemas → public → Tables**. Các bảng của ứng dụng là `users`, `rooms`, `room_members` và `messages`.

Nếu pgAdmin báo `no password supplied`, nhập lại mật khẩu PostgreSQL ở trường **Password**. Mật khẩu đăng nhập giao diện pgAdmin (`PGADMIN_DEFAULT_PASSWORD`) khác với mật khẩu kết nối database (`POSTGRES_PASSWORD`). Tên host phải là `db`, không dùng `localhost`, vì pgAdmin kết nối qua mạng Docker.

## 6. Nginx reverse proxy và security headers

Trình duyệt truy cập Nginx tại cổng 80; Nginx chuyển tiếp request HTTP, health check và Socket.IO tới ứng dụng. Kiểm tra phản hồi và headers:

```powershell
curl.exe -I http://localhost/
docker compose exec nginx nginx -t
```

Phản hồi mong đợi là HTTP `200` cùng các headers như `X-Content-Type-Options`, `X-Frame-Options` và `Referrer-Policy`. Cấu hình lab hiện dùng HTTP và chưa bật HTTPS. Helmet có thể trả header HSTS, nhưng trình duyệt chỉ ghi nhớ HSTS khi nhận header qua HTTPS; vì vậy header đó không bảo vệ phiên truy cập HTTP local.

## 7. Prometheus và Grafana

Prometheus thu thập metrics của ứng dụng, PostgreSQL qua `postgres-exporter` và container qua cAdvisor. Prometheus không publish cổng ra host; truy vấn qua Grafana:

1. Mở `http://localhost/grafana/` và đăng nhập.
2. Chọn **Dashboards → Chat Messaging → Chat Messaging - Monitoring**.
3. Kiểm tra panel scrape targets, HTTP requests, Socket.IO, CPU/RAM container và PostgreSQL.
4. Trong **Explore**, chọn datasource Prometheus và chạy:

```promql
up
pg_up
```

Giá trị `1` ở `up` cho biết target đang được scrape; `pg_up = 1` cho biết PostgreSQL exporter kết nối được tới database.

## 8. Loki và truy vấn LogQL

Promtail đọc log Docker và gửi đến Loki. Mở Grafana → **Explore**, chọn datasource **Loki**, đặt khoảng thời gian phù hợp rồi chạy từng truy vấn:

```logql
{container=~".*chat-messaging-app.*"} | json
```

```logql
{container=~".*chat-messaging-app.*"} |= "GET"
```

```logql
{container=~".*chat-messaging-app.*"} |= "POST"
```

Truy vấn JSON phân tích các trường trong log; hai truy vấn còn lại lọc request theo nội dung method. Có thể thay khoảng thời gian hoặc phát sinh thao tác đăng nhập/tạo phòng để tạo log mới. Không chia sẻ log thô có cookie, token hoặc thông tin cá nhân.

## 9. Kiểm tra trạng thái và xử lý lỗi

```powershell
docker compose ps
docker compose logs --tail 100 app nginx db postgres-exporter prometheus grafana loki promtail
```

| Hiện tượng | Cách kiểm tra / xử lý |
|---|---|
| Docker báo không mở được Docker Desktop Linux Engine hoặc named pipe | Mở Docker Desktop, đợi engine báo Running, xác nhận đang dùng Linux containers rồi chạy lại lệnh trong thư mục dự án. |
| Website không truy cập được | Kiểm tra `docker compose ps`, cổng 80 có bị chiếm không, rồi xem `docker compose logs --tail 100 nginx app`. |
| pgAdmin không đăng nhập được | Dùng `PGADMIN_DEFAULT_EMAIL` và `PGADMIN_DEFAULT_PASSWORD`; đây là thông tin đăng nhập pgAdmin, không phải mật khẩu PostgreSQL. |
| pgAdmin kết nối DB thất bại | Xác nhận `db` đang healthy; dùng host `db`, port `5432`, database/user/password từ `.env`. Xem thêm `docker compose logs --tail 100 db pgadmin`. |
| PostgreSQL exporter chưa UP | Chạy `docker compose logs --tail 100 postgres-exporter db`, xác nhận DB healthy và cấu hình `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` khớp. |
| Thay đổi cấu hình nhưng chưa có hiệu lực | Dùng `docker compose up -d --build` để áp dụng cấu hình; với thay đổi biến môi trường của một dịch vụ, có thể cần `docker compose up -d --force-recreate <service>`. |

Lưu ý: `db/init.sql` chỉ được thực thi khi PostgreSQL khởi tạo một volume dữ liệu mới. Sửa file này không tự chạy lại trên volume cũ.

## 10. Cấu hình bảo mật và giới hạn của bản lab

- Ứng dụng chạy bằng user non-root, filesystem chỉ đọc, bỏ Linux capabilities, bật `no-new-privileges` và dùng `/tmp` dạng tmpfs.
- Network `backend` và `observability` được khai báo `internal`; PostgreSQL không publish cổng host.
- `.env` bị loại khỏi Git; Nginx thêm security headers và giới hạn tốc độ API.
- cAdvisor được cấu hình `privileged: true` và mount một số đường dẫn host chỉ đọc để thu thập metrics. Đây là lựa chọn cho lab, cần rà soát trước khi dùng trên máy dùng chung hoặc môi trường production.
- Cấu hình Compose hiện dùng cùng `POSTGRES_USER`/`POSTGRES_PASSWORD` cho bootstrap PostgreSQL, ứng dụng và postgres-exporter. Vì vậy bản lab chưa tách riêng quyền database tối thiểu cho app và exporter; không mô tả đây là least-privilege hoàn chỉnh.
- `COOKIE_SECURE` đang là `false` để chạy local qua HTTP. Khi triển khai HTTPS, cần bật cookie secure, cấu hình chứng chỉ, quản lý secrets an toàn và giới hạn truy cập các trang quản trị.

## 11. Git và cấu trúc dự án

Repository: <https://github.com/dtc245200900-lab/DTC245200900-chat-messaging>

Các commit tính năng được tách rõ: ứng dụng/PostgreSQL, Nginx reverse proxy, Prometheus/Grafana, Loki/Promtail. `.env.example` là file mẫu để chia sẻ cấu hình; `.env` chứa secrets và không được commit.

```text
db/                 PostgreSQL init script
loki/               Loki và Promtail configuration
monitoring/         Prometheus, Grafana provisioning và dashboard
nginx/              Reverse proxy configuration
src/                Node.js app và giao diện web
docker-compose.yml  Dịch vụ, network và volumes
Dockerfile          Image ứng dụng
```
