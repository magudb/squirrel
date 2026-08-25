// Get meta description
function getMetaDescription() {
    const metaDesc = document.querySelector('meta[name="description"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');
    const twitterDesc = document.querySelector('meta[name="twitter:description"]');
    
    return (ogDesc && ogDesc.content) || 
           (metaDesc && metaDesc.content) || 
           (twitterDesc && twitterDesc.content) || 
           '';
}

// Get page title with fallbacks
function getPageTitle() {
    const selection = window.getSelection().toString().trim();
    if (selection) return selection;
    
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && ogTitle.content) return ogTitle.content;
    
    return document.title;
}

// Clean URL by removing tracking parameters
function cleanUrl(url) {
    const trackingParams = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
        '_ga', 'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'twclid',
        'li_fat_id', 'mc_cid', 'mc_eid', 'mkt_tok', 'yclid', 'WT.mc_id',
        '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsCtaTracking'
    ];
    
    try {
        const urlObj = new URL(url);
        trackingParams.forEach(param => {
            urlObj.searchParams.delete(param);
        });
        return urlObj.toString();
    } catch (e) {
        return url;
    }
}

// Send page data
chrome.runtime.sendMessage({
    action: 'pageDetails',
    data: {
        'title': getPageTitle(),
        'url': cleanUrl(window.location.href),
        'description': getMetaDescription(),
        'summary': window.getSelection().toString()
    }
});