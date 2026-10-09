# Деплой Gothic II Guessr

Набор рассчитан на один сервер с Debian 13 (amd64 или arm64), доступный по ssh под root по ключу. Хватает 1 vCPU и
2 ГБ RAM; диска нужно столько, сколько весит датасет, плюс 2–3 ГБ (см. «Диск»). Домен передаётся скриптам параметром
`DOMAIN`, до его появления можно сделать всё, кроме TLS.

Скрипты запускаются локально (macOS или Linux) из корня репозитория и ходят на сервер по ssh. Адрес сервера задаётся
обязательной переменной `DEPLOY_HOST`: алиас из `~/.ssh/config` или `root@host`. Без неё скрипты сразу
останавливаются с подсказкой.

```sh
export DEPLOY_HOST=my-server          # или root@203.0.113.10
```

На сервере могут жить и другие сервисы (VPN, DNS, почта), поэтому набор трогает только то, что создал сам. sshd,
fail2ban, маршрутизация, правила NAT/FORWARD, `/etc/nftables.conf` и чужие сайты nginx остаются как были (выключается
только дефолтный сайт Debian). Существующие правила файрвола не сбрасываются: если что-то фильтрует входящие
соединения, `bootstrap.sh` добавляет одно разрешающее правило для TCP 80/443 и ничего больше. `nftables.service` он
не включает никогда, потому что штатный `/etc/nftables.conf` начинается с `flush ruleset` и снёс бы правила, которые
другие программы поставили на лету. В конце `bootstrap.sh` сверяет, что все сервисы, работавшие до него, всё ещё
работают.

## Как устроено на сервере

```
клиент ──HTTPS──▶ nginx :443 ──┬─ /data/*            диск: /opt/gothic-guessr/www/data
                  (:80 → 301)  ├─ /assets/*, /ui/*   диск: /opt/gothic-guessr/app/dist
                               ├─ /api/*             ┐
                               ├─ /ws (Upgrade)      ├─▶ Node 127.0.0.1:8787 (systemd gothic-guessr, user g2)
                               └─ всё остальное      ┘   SPA-оболочка, /<ADMIN_PATH>* → admin.html
```

| Путь | Что | Владелец, права |
|---|---|---|
| `/opt/gothic-guessr/releases/<UTC>/` | сборка: `dist/`, `dist-server/main.js`, `package*.json`, `node_modules/` | root, 755/644 |
| `/opt/gothic-guessr/app` | симлинк на живой релиз | root |
| `/opt/gothic-guessr/www/data/` | публичный датасет (`worlds.json`, `<slug>/…`, `panos/<key>/…`) | root, 755/644 |
| `/opt/gothic-guessr/private/<slug>/manifest.json` | приватные манифесты с ключами узлов | g2, 700/600 |
| `/var/lib/gothic-guessr/db.sqlite` | база (systemd `StateDirectory`) | g2, 700 |
| `/var/backups/gothic-guessr/` | ежедневные бэкапы базы, 14 штук | g2, 700 |
| `/etc/gothic-guessr/env` | переменные окружения и секреты | root, 600 |

Приватные манифесты лежат вне корня nginx. На случай ошибки при публикации nginx и сам отвечает 404 на любой
`manifest.json` под `/data/`.

### Сервер приложения

Прод запускает не `tsx`, а бандл: `npm run build` включает `build:server` (esbuild собирает
`server/main.ts` вместе с `shared/` и клиентскими модулями игры в `dist-server/main.js`, npm-пакеты остаются
внешними). На сервер едет только результат сборки, там выполняется `npm ci --omit=dev`, devDependencies (tsx,
vite, typescript, playwright) не нужны. `better-sqlite3` 13 несёт готовый `linux-x64.node` внутри npm-пакета, на
сервере ничего не компилируется. Ему нужен Node ≥ 22, а в Debian 13 есть только 20, поэтому Node 24 LTS ставится
из репозитория NodeSource (ключ сверяется по закреплённому SHA-256, apt pin не даёт вернуть дебиановский 20).

`server/setup.ts` проверяет, запущен ли он как главный модуль, и в однофайловом бандле эта проверка сработала бы при
старте сервера, который тогда попытался бы писать `.env.local`. Поэтому `ensureEnvLocal` живёт в
`server/env-local.ts`, а `main.ts` импортирует её оттуда; за этим следит `tests/server/deploy.test.ts`.

Юнит `gothic-guessr.service`: `User=g2`, `EnvironmentFile=/etc/gothic-guessr/env`, `Restart=always`,
`MemoryHigh=500M`, `MemoryMax=600M`, `ProtectSystem=strict` с записью только в `/var/lib/gothic-guessr`,
`NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, фильтр системных вызовов `@system-service`, пустой набор
capabilities. Node слушает только `127.0.0.1` (`HOST` в env), а `IPAddressDeny=any` + `IPAddressAllow=localhost`
не дают процессу ходить куда-либо кроме localhost, в том числе в другие сети и сервисы хоста. `systemd-analyze security`
оценивает юнит в 1.4 (OK).

### Адрес клиента

Приложение с `TRUST_PROXY=1` берёт ПОСЛЕДНИЙ элемент `X-Forwarded-For` (`server/core/ip.ts`). nginx не дописывает
заголовок, а перезаписывает его: `proxy_set_header X-Forwarded-For $remote_addr`. Что бы клиент ни прислал в
своём `X-Forwarded-For`, приложение видит TCP-адрес, который видел nginx. Проверено: 12 запросов
`POST /api/players` с разными поддельными `X-Forwarded-For` упираются в лимит 10 в час на 11-м.

### nginx

- `/data/panos/` и `/data/<slug>/map/`: `Cache-Control: public, max-age=31536000, immutable`. Для панорам
  `Last-Modified` и `ETag` убраны, условные запросы игнорируются (как в `server/app.ts`: mtime файла намекает на
  мир и порядок рендера). `worlds.json` и `world.json` кешируются на 5 минут. Ответы 404 долгого кеша не получают.
- `/assets/` из `dist` навсегда (хеши в именах), `/ui/` на 5 минут, HTML-оболочка `no-cache` (ставит Node).
- gzip и brotli (модуль `libnginx-mod-http-brotli-filter` из Debian) только для JS, CSS и JSON. WebP не сжимается.
- HTTP/2, TLS 1.2/1.3 по профилю Mozilla intermediate. Порт 80 отдаёт ACME-челленджи и 301 на HTTPS. Запросы с
  чужим `Host` на 80 закрываются без ответа (444), на 443 рукопожатие отклоняется (`ssl_reject_handshake`).
- Заголовки (`snippets/gothic-guessr-headers.conf`): HSTS на год (без `includeSubDomains` и `preload`),
  `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP и CSP:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; …;
  connect-src 'self' wss://DOMAIN; frame-ancestors 'none'`. Стили inline нужны Photo Sphere Viewer и Leaflet.
  CSP проверен в Chromium на прод-сборке через этот nginx: меню, раунд с панорамой, карта и догадка, админка,
  daily, нарушений ноль.
- Лимиты nginx грубее лимитов приложения и нужны как первая линия на адрес:

  | Зона | nginx | Приложение (точнее) |
  |---|---|---|
  | `/api/*`, SPA | 20 r/s, burst 60 | узлы 10/s и догадки 2/s на токен, hits 60/мин на IP, игроки 10/ч на IP |
  | `/api/<ADMIN_PATH>/login` | 6 r/min, burst 5 | 5 попыток за 15 мин на IP |
  | `/ws` | 2 r/s на рукопожатия, burst 10; не больше 64 соединений на адрес | 64 сокета на IP, 4 на игрока |
  | `/data/*` | 150 r/s, burst 600; 128 одновременных запросов | нет |

  Отказ nginx в `/api` приходит как `429 {"error":"rate_limited"}` с `Retry-After: 1`, тот же формат, что у
  приложения. nginx считает IPv6 по полному адресу, приложение по /64.
- `/ws`: `Upgrade`, `proxy_read_timeout 300s` (сервер пингует каждые 30 с), без буферизации.
- Логи: `/var/log/nginx/gothic-guessr.{access,error}.log`. Тайлы, карта, `/assets` и `/ui` в access-лог не пишутся,
  отсутствующие файлы под `/data` не пишутся в error-лог. Ротацию делает штатный `/etc/logrotate.d/nginx` из
  пакета Debian (ежедневно, 14 файлов, gzip), он покрывает `/var/log/nginx/*.log`.
- `bootstrap.sh` поднимает `worker_connections` с 768 до 4096 и `worker_rlimit_nofile` до 16384: каждый WebSocket
  держит два соединения (клиент и upstream), и 768 хватило бы примерно на 300 игроков в комнатах.

### TLS

`tls.sh` получает сертификат через webroot (`/var/www/letsencrypt`), certbot конфиг nginx не правит. Продление
делает штатный `certbot.timer` (дважды в сутки), хук `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx`
перезагружает nginx. Перед запросом скрипт сверяет A и AAAA домена с адресами сервера: если у сервера есть IPv6, а
AAAA указывает в другое место, Let's Encrypt пойдёт по IPv6 и проверка провалится.

## Порядок действий

До появления домена можно сделать всё, кроме TLS.

```sh
deploy/scripts/bootstrap.sh                          # сухой прогон: что поставит и изменит, ничего не меняет
deploy/scripts/bootstrap.sh --yes --journal-cap 300M # пакеты, Node 24, пользователь g2, каталоги, юниты, nginx
deploy/scripts/secrets.sh                            # /etc/gothic-guessr/env, секреты генерируются на сервере
deploy/scripts/push-data.sh                          # ~18 ГБ; при обрыве просто запустить ещё раз
deploy/scripts/push-app.sh                           # тесты, сборка, релиз, рестарт, проверка /api/health

# проверка без домена: туннель на Node, он сам отдаёт и SPA, и /data
ssh -N -L 8080:127.0.0.1:8787 "$DEPLOY_HOST"         # затем http://localhost:8080
```

Когда домен есть: A-запись на IPv4 сервера, AAAA на его IPv6 или никакой.

```sh
deploy/scripts/tls.sh DOMAIN EMAIL --staging         # по желанию: репетиция на тестовом центре LE
deploy/scripts/tls.sh DOMAIN EMAIL                   # сертификат, сайт nginx, таймер продления
deploy/scripts/secrets.sh --domain DOMAIN --restart  # PUBLIC_ORIGIN=https://DOMAIN для текстов «поделиться»
deploy/scripts/status.sh
ssh "$DEPLOY_HOST" grep ADMIN_ /etc/gothic-guessr/env # пароль и путь админки, только в своём терминале
```

Дальше:

| Задача | Команда |
|---|---|
| выкатить новую версию | `deploy/scripts/push-app.sh` (если новый релиз не ответит за 20 с, вернётся старый) |
| откатить | `deploy/scripts/push-app.sh --rollback` |
| обновить данные | `deploy/scripts/push-data.sh --restart` (рестарт перечитывает манифесты, комнаты в памяти пропадут) |
| другой вариант датасета | `deploy/scripts/push-data.sh --source <каталог> --delete --dry-run`, затем без `--dry-run` |
| применить правки шаблона nginx | `deploy/scripts/tls.sh DOMAIN EMAIL` (сертификат не перевыпускается) |
| сменить пароль админки | `deploy/scripts/secrets.sh --rotate-admin --restart` |
| сменить путь админки | убрать строку `ADMIN_PATH` из `/etc/gothic-guessr/env`, затем `secrets.sh --restart` (запишет новый) и `tls.sh DOMAIN EMAIL` (лимит на логин в nginx) |
| сервер настроен до появления `ADMIN_PATH` | `secrets.sh`, потом `push-app.sh` и `tls.sh DOMAIN EMAIL`: без `ADMIN_PATH` новый релиз не стартует и откатится |
| бэкап вручную | `ssh "$DEPLOY_HOST" systemctl start gothic-guessr-backup` |
| забрать бэкапы себе | `rsync -a "$DEPLOY_HOST":/var/backups/gothic-guessr/ ~/Backups/gothic-guessr/` |
| состояние | `deploy/scripts/status.sh` (сервисы, прочие сервисы хоста, health, память, сертификат, диск, логи) |

Восстановление базы: остановить `gothic-guessr`, `gunzip -c db-….sqlite.gz > /var/lib/gothic-guessr/db.sqlite`,
удалить `db.sqlite-wal` и `db.sqlite-shm`, `chown g2:g2`, запустить.

## Скрипты

| Файл | Что делает |
|---|---|
| `scripts/bootstrap.sh [--yes]` | без `--yes` только показывает план. С `--yes` ставит nginx, brotli, certbot, sqlite3, rsync и Node из NodeSource, создаёт `g2` и каталоги, ставит юниты и сниппеты, тюнит `nginx.conf` (оригинал в `nginx.conf.g2-orig`), выключает дефолтный сайт Debian и включает HTTP-заглушку для ACME. Порты 80/443 открывает, только если их что-то фильтрует. Опции `--node-major`, `--build-tools`, `--journal-cap` |
| `scripts/secrets.sh` | пишет `/etc/gothic-guessr/env`; `ADMIN_PASSWORD`, `ADMIN_PATH` (`admin-` и 16 случайных символов base32) и `SERVER_SECRET` генерируются из `/dev/urandom` на сервере и никуда не выводятся; повторный запуск сохраняет секреты; `SERVER_SECRET` скрипт не ротирует, от него зависят сиды всех прошлых daily |
| `scripts/push-data.sh` | rsync `public/data` и `server-data/*/manifest.json`, `--partial-dir`, до 8 повторов; исключает `panos-cmp/`, бэкапы, `.DS_Store`, AppleDouble; падает, если под публичным каталогом найден `manifest.json`; перед передачей сверяет свободное место |
| `scripts/push-app.sh` | `npm test`, `npm run build`, tar сборки на сервер в новый релиз, `npm ci --omit=dev` (или жёсткие ссылки на `node_modules` прошлого релиза, если lock не менялся), проверка загрузки `better-sqlite3` от имени g2, переключение симлинка, рестарт, health-check с откатом; хранит три релиза |
| `scripts/tls.sh DOMAIN EMAIL` | проверка DNS, certbot webroot, рендер шаблонов (`__ADMIN_PATH__` берётся из `/etc/gothic-guessr/env`, поэтому сначала `secrets.sh`; готовый сайт лежит с правами root 0640), `nginx -t` с возвратом прежнего конфига при ошибке, хук продления, smoke-тест |
| `scripts/backup-db.sh` | на сервере, из `gothic-guessr-backup.timer` (03:30 UTC ± 20 мин): `sqlite3 .backup`, `PRAGMA integrity_check`, gzip, ротация 14 |
| `scripts/status.sh` | только чтение |
| `scripts/lib.sh`, `scripts/docker-rsh.sh` | общие функции; `DEPLOY_HOST=docker:<контейнер>` гоняет весь набор в локальном контейнере |


## Трафик и измеренная ёмкость

Средние по датасету из трёх миров (5590 панорам, 168 тыс. файлов): шесть базовых граней панорамы весят 244 КБ, все 24
тайла 2,9 МБ (16 боковых 2,2 МБ, верх и низ 0,7 МБ), у узла в среднем 2,3 соседа. Тайл карты около 12 КБ.

Замер в Chromium на прод-сборке (масштаб по умолчанию, поле зрения около 86°):

| Момент | 1920×1080 | 1280×720 |
|---|---|---|
| старт раунда, камера не трогалась (база, видимые тайлы, базы соседей) | 2,2 МБ, 34 файла | 2,0 МБ, 28 |
| после полного оборота на 360° | 3,8 МБ, 48 | 3,7 МБ, 42 |
| карта: три шага зума и клик | 1,1 МБ, 84 тайла | 0,7 МБ, 53 |
| оболочка приложения при первом заходе | 1,1 МБ без сжатия, около 0,4 МБ с brotli | |

Шаг к соседу стоит примерно 1,5–2 МБ: его база уже предзагружена, докачиваются видимые тайлы и базы новых соседей.
Раунд с осмотром, тремя шагами и картой выходит около 10 МБ, раунд «посмотрел и угадал» около 3 МБ. Игра из пяти
раундов занимает 15–50 МБ, в среднем примерно 30 МБ. Раунд длится 1–2 минуты, так что один активный игрок в среднем
тянет 0,3–1,3 Мбит/с, а в начале раунда 2–4 МБ за секунду-две. 1000 игр в день дают около 30 ГБ трафика в сутки,
0,9 ТБ в месяц.

Оценка для 1 vCPU и 2 ГБ RAM:

- nginx отдаёт статику через `sendfile`, TLS с AES-NI упрётся в процессор на сотнях Мбит/с. Node обслуживает только
  API и WebSocket, это десятки запросов за раунд.
- Первым кончится канал. При 100 Мбит/с комфортно 100–150 одновременно играющих; при 1 Гбит/с потолок задаёт
  процессор, порядка 300–500 игроков, и меньше, если ядро делят другие нагруженные сервисы. Скорость порта и квоту
  трафика смотрите у своего провайдера: изнутри без нагрузочного теста их не измерить.
- Память: Node после старта занимает около 35 МБ (потолок в юните 600 МБ), nginx около 20 МБ. Остальное уходит под
  страничный кеш; датасет в него целиком не влезает, тайлы читаются с диска.

Что смотреть: `status.sh` (память, рестарты, диск), долю ответов 429 в `/var/log/nginx/gothic-guessr.access.log`
(`awk '$9 == 429' … | wc -l`).

### Диск

Полный датасет занимает 18,2 ГБ, на файловой системе с блоками по 4 КБ около 18,5 ГБ. Копия для деплоя из
`tools/make_release.py` (грани 1536 px, WebP q70) заметно меньше. Пакеты и Node около 0,5 ГБ, релиз около 30 МБ
(хранятся три).

- `bootstrap.sh --journal-cap 300M` ограничивает журнал systemd через drop-in.
- База растёт в основном от аналитики посещений (строка на переход по странице) и сыгранных игр: при тысячах
  визитов в день это единицы МБ в сутки. Бэкапов 14, сжатые.
- access-лог без тайлов: около 50–100 строк на игру, при 1000 игр в день примерно 20 МБ в сутки до сжатия.
- Если два варианта датасета рядом не помещаются, вариант меняется на месте: `push-data.sh --source … --delete`.
  Панорамы отдаются как `immutable` на год, поэтому если вариант меняет содержимое файла по тому же URL, у
  вернувшихся игроков останутся старые тайлы из кеша браузера.

## Риски

- Если на сервере есть другие сервисы, они делят с игрой процессор и канал. Всплеск игроков они почувствуют первыми.
- Внешний файрвол провайдера (панель, security group) изнутри не виден. После `bootstrap.sh` стоит проверить снаружи
  `curl -I http://<IP сервера>/` (ожидается пустой ответ от 444, а не таймаут).
- NodeSource сторонний репозиторий. Ключ закреплён по хешу; если NodeSource его сменит, `bootstrap.sh`
  остановится и попросит проверить новый ключ вручную.
- `push-app.sh` проверяет загрузку нативного модуля `better-sqlite3` от имени g2 до переключения релиза, так что
  сломанный модуль до прода не дойдёт.
- Лимит приложения «10 новых игроков в час на IP» общий для всех за одним NAT (мобильные операторы, общежития).
  Это решение приложения, nginx его не смягчает.
- Рестарт Node (выкатка, `push-data.sh --restart`, `--rotate-admin`) обрывает комнаты: они живут в памяти.
- Пока идёт первая заливка данных, раунды могут попадать на ещё не залитые панорамы. Приложение стоит запускать
  (`push-app.sh`) после того, как `push-data.sh` дошёл до конца.
- Бэкапы лежат на том же диске; их нужно периодически забирать к себе.
- Без swap при 600 МБ потолка у Node и ~20 МБ у nginx запас на 2 ГБ есть, но OOM-killer в случае чего придёт к
  кому-то из соседних процессов.

## Как проверялось

- `npm test` и `npm run build` зелёные; бандл `dist-server/main.js` запускался локально с реальными данными: `/`,
  `/play`, `/<ADMIN_PATH>`, `/api/health`, `/api/daily`, `/data/worlds.json`, тайл карты и тайл панорамы отвечают 200,
  `manifest.json` 404.
- Шаблон nginx отрендерен для тестового домена и проверен в контейнере Debian 13 (nginx 1.26.3 с brotli):
  `nginx -t`, заголовки кеша, отсутствие `Last-Modified`/`ETag` у панорам, 404 на манифесты и `.rsync-partial`,
  brotli/gzip для JS, 301 с HTTP, 444 и отказ TLS для чужого имени, 429 в JSON, WebSocket ping/pong через nginx,
  подмена `X-Forwarded-For`.
- Весь набор скриптов прогнан против контейнера Debian 13 с systemd (`DEPLOY_HOST=docker:<имя>`): bootstrap (дважды,
  второй раз без изменений), secrets (секреты не меняются при повторе, меняются при `--rotate-admin`), push-data
  на подмножестве из 100 панорам (повтор передаёт 0 файлов, `--delete --dry-run`), push-app (две выкатки и откат),
  tls с самоподписанным сертификатом, backup через systemd, status. Юнит работает со всей песочницей.
- `shellcheck` по скриптам и по встроенным удалённым частям: замечаний уровня warning нет.

Для повторного прогона в контейнере: привилегированный контейнер с systemd на Docker Desktop перезаписывает
обработчики `binfmt_misc` общей виртуалки (запуск `systemd-binfmt`), после чего x86-образы перестают запускаться
до перезапуска Docker Desktop. В тестовом образе нужно заранее сделать
`systemctl mask systemd-binfmt.service proc-sys-fs-binfmt_misc.automount`.
