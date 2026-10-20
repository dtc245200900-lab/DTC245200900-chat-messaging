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

## 12. Đối chiếu tiêu chí đánh giá và minh chứng

Bảng dưới đây liên kết từng tiêu chí với phần cần mở khi thuyết trình. Hãy chụp ảnh màn hình sau khi chạy hệ thống và lưu vào `docs/evidence/` trong repository. Không chụp hoặc đưa `.env`, mật khẩu, cookie hay token vào ảnh.

| Tiêu chí | Nội dung cần trình bày | Minh chứng nên mở |
|---|---|---|
| 1. Quản lý mã nguồn trên GitHub | Repository có source, cấu hình, README; các commit chia theo tính năng. | Trang repository, README, lịch sử commit. Chạy `git log --oneline` để giải thích các commit. |
| 2. Ứng dụng + database + công cụ quản lý DB | Tạo/đăng nhập tài khoản, tạo phòng, tham gia bằng ID và gửi tin nhắn; PostgreSQL lưu dữ liệu; pgAdmin xem được database. | Website sau khi gửi tin nhắn; pgAdmin mở `internal_chat → Schemas → public → Tables` và các bảng `users`, `rooms`, `room_members`, `messages`. |
| 3. Nginx reverse proxy | Truy cập website qua Nginx và chỉ ra các security headers. Bản hiện tại dùng HTTP local, chưa cấu hình HTTPS. | Trình duyệt tại `http://localhost/`; kết quả `curl.exe -I http://localhost/`; file `nginx/default.conf`. |
| 4. Prometheus + Grafana | Dashboard có metrics container, ứng dụng/web và PostgreSQL; truy vấn xác nhận target. | Dashboard **Chat Messaging - Monitoring**; Grafana Explore với PromQL `up` và `pg_up`. `pg_up = 1` là bằng chứng exporter truy cập được PostgreSQL. |
| 5. Loki + Promtail | Log được gửi tập trung và truy vấn bằng ít nhất 2–3 câu LogQL. | Grafana Explore chọn Loki, lần lượt chạy ba truy vấn ở mục 8; nếu chưa có log mới, đăng nhập hoặc gửi tin nhắn rồi chạy lại. |
| 6. Hardening | Giải thích các biện pháp đã cấu hình và nêu giới hạn còn lại. | Mục 10 của README; `Dockerfile` cho user non-root; `docker-compose.yml` cho network/capabilities/read-only; `nginx/default.conf` cho headers và rate limit; `.gitignore` để chứng minh `.env` không được commit. |
| 7. Tổng thể, trình bày và demo | Khởi động được bằng Docker Compose, trình bày luồng hoạt động, có ảnh minh chứng và giải thích được các thành phần. | Chạy `docker compose ps`; lần lượt mở website, pgAdmin, Nginx headers, Grafana và LogQL theo kịch bản ở mục 13. |

Các ảnh nên chuẩn bị: `01-compose-status.png`, `02-chat-message.png`, `03-pgadmin-tables.png`, `04-nginx-headers.png`, `05-grafana-dashboard.png`, `06-prometheus-up-pgup.png`, `07-loki-logql.png` và `08-hardening.png`. Chỉ ghi nhận đúng kết quả thực tế; không dùng ảnh minh họa thay cho dịch vụ chưa chạy.

## 13. Kịch bản demo nhanh trước giảng viên

### Chuẩn bị trước giờ demo

Mở Docker Desktop, mở PowerShell tại thư mục repository và chạy:

```powershell
docker compose up -d --build
docker compose --profile admin up -d pgadmin
docker compose ps
```

Chờ database báo `healthy` và các dịch vụ ở trạng thái `Up`. Nếu vừa tạo `.env` hoặc đổi cấu hình, kiểm tra các giá trị cần thiết trước giờ trình bày; tuyệt đối không chiếu nội dung bí mật của file này.

### Trình tự trình bày

1. **Giới thiệu mã nguồn:** mở repository GitHub, README và `git log --oneline`; nói ngắn gọn mỗi nhóm commit bổ sung thành phần nào.
2. **Demo ứng dụng:** mở `http://localhost/`, đăng nhập hoặc tạo hai tài khoản, tạo phòng ở tài khoản thứ nhất, dùng ID phòng cho tài khoản thứ hai, rồi gửi tin nhắn giữa hai phía.
3. **Chứng minh database:** mở `http://localhost/pgadmin/`, đăng nhập bằng thông tin `PGADMIN_DEFAULT_EMAIL` và `PGADMIN_DEFAULT_PASSWORD` trong `.env`, kết nối server bằng host `db`, rồi mở các bảng trong `internal_chat`. Nếu cần chứng minh dữ liệu, dùng **View/Edit Data → All Rows** trên bảng `messages` hoặc `rooms`.
4. **Chứng minh Nginx:** chạy `curl.exe -I http://localhost/`; chỉ ra mã phản hồi và các header `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`. Nêu rõ demo local hiện dùng HTTP, chưa có HTTPS.
5. **Chứng minh giám sát:** mở `http://localhost/grafana/`, vào dashboard **Chat Messaging - Monitoring**, sau đó vào Explore chọn Prometheus và chạy `up`, `pg_up`.
6. **Chứng minh log tập trung:** trong Explore chọn Loki, chạy các truy vấn JSON, GET và POST ở mục 8. Tạo một request trên website để có log mới nếu cần.
7. **Giải thích hardening:** mở `Dockerfile`, `docker-compose.yml`, `nginx/default.conf` và mục 10; chạy lệnh sau để cho thấy tiến trình ứng dụng không chạy bằng root:

```powershell
docker compose exec app id
```

Kết quả mong đợi có `uid=1000(node)`. Nêu thêm các network nội bộ, PostgreSQL không publish cổng host, `.env` bị loại khỏi Git và security headers. Đồng thời nói rõ các giới hạn đã nêu ở mục 10, đặc biệt cAdvisor cần quyền cao và database chưa tách role riêng cho app/exporter.

### Thu dọn sau demo

```powershell
docker compose down
```

Lệnh này dừng và xóa container nhưng giữ dữ liệu trong named volumes. Tránh `docker compose down -v` nếu cần giữ tài khoản, tin nhắn và dữ liệu dashboard cho lần trình bày tiếp theo.
