import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { FetchError } from "./errors.js";

export interface UrlPolicy {
  /**
   * Allow loopback / private / link-local targets. Off in production (SSRF protection);
   * on for local development and the batch command, whose test sites run on localhost.
   */
  allowPrivateHosts: boolean;
}

export const productionPolicy: UrlPolicy = { allowPrivateHosts: false };

export function defaultPolicy(): UrlPolicy {
  if (process.env.ALLOW_PRIVATE_HOSTS === "true") return { allowPrivateHosts: true };
  if (process.env.ALLOW_PRIVATE_HOSTS === "false") return { allowPrivateHosts: false };
  return { allowPrivateHosts: process.env.NODE_ENV !== "production" };
}

/** Parse user input into an http(s) URL. Accepts a bare domain ("acme.com") for convenience. */
export function parseHttpUrl(raw: string): URL {
  const input = raw.trim();
  if (!input) throw new FetchError("INVALID_URL", "URL is empty", raw);
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new FetchError("INVALID_URL", `Not a valid URL: ${raw}`, raw);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError("INVALID_URL", `Only http and https URLs are supported (got ${url.protocol})`, raw);
  }
  if (url.username || url.password) throw new FetchError("INVALID_URL", "URLs with credentials are not allowed", raw);
  if (!url.hostname) throw new FetchError("INVALID_URL", "URL has no host", raw);
  url.hash = "";
  return url;
}

/**
 * Resolve the host and refuse non-public addresses unless the policy allows them.
 * Checked again on every redirect hop. Residual risk: DNS rebinding between this
 * lookup and the connection (noted in README).
 */
export async function assertUrlAllowed(url: URL, policy: UrlPolicy): Promise<void> {
  if (policy.allowPrivateHosts) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (ipaddr.isValid(host)) {
    addresses = [host];
  } else {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
      throw new FetchError("BLOCKED_URL", `Refusing to fetch internal host ${host}`, url.href);
    }
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new FetchError("NETWORK", `Could not resolve host ${host}`, url.href);
    }
  }
  for (const address of addresses) {
    const range = ipaddr.process(address).range();
    if (range !== "unicast") {
      throw new FetchError("BLOCKED_URL", `Refusing to fetch ${host}: resolves to a ${range} address`, url.href);
    }
  }
}
