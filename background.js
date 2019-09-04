function getPageDetails(callback) { 
    // Inject the content script into the current page 
    browser.tabs.executeScript(null, { file: 'content.js' }); 
    // Perform the callback when a message is received from the content script
    browser.runtime.onMessage.addListener(function(message)  { 
        // Call the callback function
        callback(message); 
    }); 
};

