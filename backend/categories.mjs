export function leafOdooCategoryName(categPath) {
  if (!categPath) return null;
  const parts = categPath.split('/').map(p => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

export function primaryTiendanubeCategory(categories) {
  if (!categories || categories.length === 0) return null;
  return categories[0].name?.es || null;
}
