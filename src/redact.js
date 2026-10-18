import { homedir } from 'node:os';

const SECRET_NAME = /(?:^|[_-])(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH|COOKIE|SESSION)(?:$|[_-])/i;
const SECRET_FLAG = /^--?(?:.*(?:token|secret|password|passwd|api[-_]?key|credential|auth|cookie|session))$/i;
const VALUE_MARKER = '<REDACTED>';

export function redactCommand(argv) {
  let hidden = false;
  const redacted = argv.map((argument, index) => {
    if (index > 0 && SECRET_FLAG.test(argv[index - 1])) {
      hidden = true;
      return VALUE_MARKER;
    }
    const equals = argument.indexOf('=');
    if (equals > 0 && SECRET_FLAG.test(argument.slice(0, equals))) {
      hidden = true;
      return `${argument.slice(0, equals + 1)}${VALUE_MARKER}`;
    }
    return argument;
  });
  return { argv: redacted, redacted: hidden };
}

export function createRedactor(env = process.env) {
  const secrets = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  const home = homedir();
  return (input) => {
    let output = String(input);
    for (const secret of secrets) output = output.split(secret).join(VALUE_MARKER);
    output = output.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, `$1${VALUE_MARKER}`);
    output = output.replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;"']+/gi, `$1${VALUE_MARKER}`);
    if (home && home !== '/') output = output.split(home).join('<HOME>');
    return output;
  };
}
