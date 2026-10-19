// A pasted secret may have exterior CR/LF. Internal controls are never repaired
// silently, and validation errors must not include any part of the credential.
export function npmPublishEnvironment(environment) {
  const env = { ...environment }, token = (env.NPM_TOKEN ?? '').trim();
  delete env.NPM_TOKEN;
  delete env.NODE_AUTH_TOKEN; // setup-node's placeholder must not disable OIDC.
  if (token) {
    if (/[^\x21-\x7e]/u.test(token)) throw new Error('NPM_TOKEN contains internal whitespace or non-ASCII controls; copy only the token into the release secret.');
    env.NODE_AUTH_TOKEN = token;
  }
  return env;
}
