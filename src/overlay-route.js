function staticAssetUrl(requestUrl, pathname) {
  const source = new URL(requestUrl);
  const asset = new URL(pathname, source.origin);
  asset.search = source.search;
  return asset.toString();
}

export function overlayAssetUrl(requestUrl) {
  return staticAssetUrl(requestUrl, '/overlay.html');
}

export function goalAssetUrl(requestUrl) {
  return staticAssetUrl(requestUrl, '/goal.html');
}
