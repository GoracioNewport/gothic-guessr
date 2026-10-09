# Деплой

Набор для продакшена лежит в [`deploy/`](../deploy/README.md): nginx перед Node, systemd-юниты, скрипты установки,
заливки данных и приложения, TLS через Let's Encrypt, бэкапы базы. Описание, порядок команд, оценка трафика и
риски собраны в [deploy/README.md](../deploy/README.md).

Коротко:

```sh
export DEPLOY_HOST=my-server     # ssh-алиас или root@host, без него скрипты не запускаются
deploy/scripts/bootstrap.sh --yes --journal-cap 300M
deploy/scripts/secrets.sh
deploy/scripts/push-data.sh
deploy/scripts/push-app.sh
deploy/scripts/tls.sh DOMAIN EMAIL
deploy/scripts/secrets.sh --domain DOMAIN --restart
```
