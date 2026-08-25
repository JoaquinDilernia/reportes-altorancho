function sum(rows, key) {
  return rows.reduce((total, row) => total + (row[key] || 0), 0);
}

export function computeAdTotals(dailyRows) {
  const spend = sum(dailyRows, 'spend');
  const impressions = sum(dailyRows, 'impressions');
  const reach = sum(dailyRows, 'reach');
  const clicks = sum(dailyRows, 'clicks');
  const purchases = sum(dailyRows, 'purchases');
  const purchaseValue = sum(dailyRows, 'purchaseValue');
  const addToCart = sum(dailyRows, 'addToCart');
  const initiateCheckout = sum(dailyRows, 'initiateCheckout');
  const landingPageViews = sum(dailyRows, 'landingPageViews');

  return {
    spend, impressions, reach, clicks, purchases, purchaseValue, addToCart, initiateCheckout, landingPageViews,
    ctr: impressions ? (clicks / impressions) * 100 : 0,
    cpc: clicks ? spend / clicks : 0,
    roas: spend ? purchaseValue / spend : 0,
    costPerPurchase: purchases ? spend / purchases : 0,
    costPerAddToCart: addToCart ? spend / addToCart : 0,
  };
}

export function computeAdDailyBreakdown(dailyRows) {
  return dailyRows
    .map(row => ({ date: row.date, spend: row.spend, purchases: row.purchases }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function computeTopAds(adDailyRows, { limit = 10 } = {}) {
  const byAd = new Map();

  for (const row of adDailyRows) {
    if (!byAd.has(row.adId)) {
      byAd.set(row.adId, {
        adId: row.adId, adName: row.adName, campaignName: row.campaignName,
        spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0,
      });
    }
    const entry = byAd.get(row.adId);
    entry.spend += row.spend || 0;
    entry.impressions += row.impressions || 0;
    entry.clicks += row.clicks || 0;
    entry.purchases += row.purchases || 0;
    entry.purchaseValue += row.purchaseValue || 0;
    entry.adName = row.adName;
    entry.campaignName = row.campaignName;
  }

  return [...byAd.values()]
    .map(entry => ({
      ...entry,
      ctr: entry.impressions ? (entry.clicks / entry.impressions) * 100 : 0,
      cpc: entry.clicks ? entry.spend / entry.clicks : 0,
      costPerPurchase: entry.purchases ? entry.spend / entry.purchases : 0,
      roas: entry.spend ? entry.purchaseValue / entry.spend : 0,
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, limit);
}
