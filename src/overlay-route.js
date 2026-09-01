export function overlayAssetUrl(requestUrl) {
  const source = new URL(requestUrl);
  const asset = new URL('/overlay.html', source.origin);
  asset.search = source.search;
  return asset.toString();
}
