export type DealResult = {
    title: string;
    url?: string;
    price?: string;
    source?: string;
};

const URL_RE = /(https?:\/\/[\w.-]+[^\s)]*)/i;
const PRICE_RE = /\$\s?([0-9]+(?:\.[0-9]{1,2})?)/;

export function extractDeals(text: string, max = 3): DealResult[] {
    if (!text) return [];
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

    const deals: DealResult[] = [];
    for (const line of lines) {
        const urlMatch = line.match(URL_RE);
        const priceMatch = line.match(PRICE_RE);
        const title = line.replace(URL_RE, "").trim() || line;
        deals.push({
            title,
            url: urlMatch ? urlMatch[1] : undefined,
            price: priceMatch ? `$${priceMatch[1]}` : undefined,
            source: line.includes("amazon") ? "Amazon" : line.includes("ebay") ? "eBay" : undefined,
        });
        if (deals.length >= max) break;
    }
    return deals;
}
