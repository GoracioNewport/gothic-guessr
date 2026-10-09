/**
 * Guards for the production deploy kit (deploy/): invariants that the app's own code relies on but that live in
 * config files, so a later edit of either side cannot silently break the other.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

describe('deploy kit', () => {
  it('main.ts never imports the setup entry (its "am I main" check would fire inside the server bundle)', () => {
    expect(read('server/main.ts')).not.toMatch(/from '\.\/setup'/);
  });

  it('nginx overwrites X-Forwarded-For with the peer address (TRUST_PROXY takes the last entry)', () => {
    const conf = read('deploy/nginx/gothic-guessr.conf.template');
    expect(conf).not.toContain('$proxy_add_x_forwarded_for');
    const xff = conf.split('\n').filter((l) => /proxy_set_header\s+X-Forwarded-For/.test(l));
    expect(xff.length).toBeGreaterThanOrEqual(2); // server level + the /ws location
    for (const line of xff) expect(line).toMatch(/X-Forwarded-For\s+\$remote_addr;/);
  });

  it('nginx refuses manifests under /data and strips pano validators', () => {
    const conf = read('deploy/nginx/gothic-guessr.conf.template');
    expect(conf).toMatch(/manifest\\\.json\$/);
    const panos = conf.slice(conf.indexOf('location ^~ /data/panos/'));
    expect(panos).toMatch(/etag off;[\s\S]*add_header Last-Modified "";/);
  });

  it('the admin login rate limit follows ADMIN_PATH: templated in nginx, filled by tls.sh from the server env', () => {
    const conf = read('deploy/nginx/gothic-guessr.conf.template');
    expect(conf).toContain('location = /api/__ADMIN_PATH__/login {');
    expect(conf).not.toMatch(/\/api\/admin\b/);
    const login = conf.slice(conf.indexOf('location = /api/__ADMIN_PATH__/login'));
    expect(login.slice(0, login.indexOf('}'))).toContain('limit_req zone=g2_login');
    const tls = read('deploy/scripts/tls.sh');
    expect(tls).toMatch(/admin_path=\$\(sed -n 's\/\^ADMIN_PATH=\/\/p' \/etc\/gothic-guessr\/env/);
    expect(tls).toContain('-e "s/__ADMIN_PATH__/$admin_path/g"');
    expect(tls).toContain("grep -q '__[A-Z_]*__' \"$site.new\"");
    // Never printed: no echo/say of the value.
    expect(tls).not.toMatch(/(echo|say)[^\n]*\$admin_path/);
  });

  it('secrets.sh writes a random ADMIN_PATH (never `admin`) and never prints it', () => {
    const script = read('deploy/scripts/secrets.sh');
    expect(script).toContain('echo "ADMIN_PATH=$admin_path"');
    expect(script).toContain('admin_path="admin-$(head -c 10 /dev/urandom | base32');
    expect(script).toMatch(/\$admin_path == admin \]\]/);
    const outsideFile = script.replace('echo "ADMIN_PATH=$admin_path"', '');
    expect(outsideFile).not.toMatch(/(echo|say|printf)[^\n]*\$\{?admin_path/);
    expect(script).toContain('grep ADMIN_ /etc/gothic-guessr/env');
  });

  it('the kit has no built-in target: DEPLOY_HOST is required before anything talks to a server', () => {
    const lib = read('deploy/scripts/lib.sh');
    expect(lib).toContain('DEPLOY_HOST=${DEPLOY_HOST:-}\n');
    expect(lib).not.toMatch(/DEPLOY_HOST:-[^}]/);
    expect(lib).toMatch(/g2_ssh\(\) \{\n\s+g2_need_host/);
    expect(lib).toMatch(/g2_check_ssh\(\) \{\n\s+g2_need_host/);
  });

  it('the env written by secrets.sh binds the app to localhost and trusts the proxy', () => {
    const script = read('deploy/scripts/secrets.sh');
    for (const line of ['HOST=127.0.0.1', 'PORT=8787', 'TRUST_PROXY=1', 'NODE_ENV=production']) {
      expect(script).toContain(`echo "${line}"`);
    }
  });
});
