const DEFAULT_PROD_API_BASE = 'https://artstation.harrison-martin.com/api';
const DEFAULT_DEV_API_BASE = 'http://localhost:3005/api';

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

export function getApiBaseUrl() {
  const envBaseUrl = process.env.REACT_APP_API_BASE_URL;

  if (envBaseUrl) {
    return stripTrailingSlash(envBaseUrl);
  }

  if (process.env.NODE_ENV === 'development') {
    return DEFAULT_DEV_API_BASE;
  }

  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname.toLowerCase();
    const isApiHost = hostname.startsWith('artstation.');

    // backend lives on the artstation subdomain
    if (isApiHost) {
      return `${window.location.protocol}//${window.location.host}/api`;
    }
  }

  return '/api';
}

export function apiUrl(pathname = '') {
  const base = getApiBaseUrl();

  if (!pathname) {
    return base;
  }

  return pathname.startsWith('/') ? `${base}${pathname}` : `${base}/${pathname}`;
}
