#!/bin/bash
# rsync remote shell for testing the kit against a local container (DEPLOY_HOST=docker:<name>, see lib.sh):
# rsync calls `docker-rsh.sh <name> <host> <command...>`; the host argument is ignored.
name=$1; shift 2
exec docker exec -i "$name" "$@"
