// Background service worker for Chrome Extension Manifest V3

// Store page details temporarily
let pageDetails = {};

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'pageDetails') {
        // Store details with tab ID as key
        if (sender.tab && sender.tab.id) {
            pageDetails[sender.tab.id] = message.data;
        }
        sendResponse({received: true});
    } else if (message.action === 'getPageDetails') {
        // Request from popup
        chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
            if (tabs[0]) {
                const tabId = tabs[0].id;
                
                // If we already have details for this tab, send them
                if (pageDetails[tabId]) {
                    sendResponse(pageDetails[tabId]);
                    delete pageDetails[tabId]; // Clear after use
                } else {
                    // Check if URL is accessible (not chrome://, edge://, about:, etc.)
                    const url = tabs[0].url;
                    const isRestrictedUrl = !url || 
                        url.startsWith('chrome://') || 
                        url.startsWith('edge://') || 
                        url.startsWith('about:') ||
                        url.startsWith('chrome-extension://') ||
                        url.startsWith('devtools://') ||
                        url.startsWith('view-source:') ||
                        url.startsWith('file://');
                    
                    if (isRestrictedUrl) {
                        // Can't inject script on restricted URLs, just return basic info
                        sendResponse({
                            title: tabs[0].title || 'Restricted Page',
                            url: url || '',
                            description: '',
                            summary: ''
                        });
                    } else {
                        // Inject content script and get details
                        try {
                            await chrome.scripting.executeScript({
                                target: { tabId: tabId },
                                files: ['content.js']
                            });
                            
                            // Wait a bit for content script to send data
                            setTimeout(() => {
                                if (pageDetails[tabId]) {
                                    sendResponse(pageDetails[tabId]);
                                    delete pageDetails[tabId];
                                } else {
                                    // Fallback with basic info
                                    sendResponse({
                                        title: tabs[0].title,
                                        url: tabs[0].url,
                                        description: '',
                                        summary: ''
                                    });
                                }
                            }, 100);
                        } catch (err) {
                            console.error('Failed to inject content script:', err);
                            // Fallback with basic info
                            sendResponse({
                                title: tabs[0].title,
                                url: tabs[0].url,
                                description: '',
                                summary: ''
                            });
                        }
                    }
                }
            }
        });
        return true; // Will respond asynchronously
    }
});