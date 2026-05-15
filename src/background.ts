import { Link, BlogPost } from './types';

// Service worker for Manifest V3
chrome.runtime.onInstalled.addListener(() => {
  console.log('Squirrel extension installed');
});

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Validate sender is from this extension
  if (sender.id !== chrome.runtime.id) {
    console.warn('Message from unknown sender:', sender.id);
    sendResponse({ success: false, error: 'Unauthorized' });
    return;
  }

  if (request.action === 'addLinkToBlog') {
    // Validate message structure
    if (!request.link?.url || !request.link?.title || !request.blogFile?.path) {
      sendResponse({ success: false, error: 'Invalid message structure' });
      return;
    }
    handleAddLinkToBlog(request.link, request.blogFile)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('Error in addLinkToBlog:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep message channel open for async response
  }

  if (request.action === 'getSelectedText') {
    // Forward to content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, request, sendResponse);
      }
    });
    return true;
  }
});

async function handleAddLinkToBlog(link: Link, blogFile: BlogPost): Promise<{ success: boolean; error?: string }> {
  try {
    // In a real implementation, this would make an API call to a backend service
    // that handles the file operations on the blog repository
    
    console.log('Would add link to blog:', {
      link: {
        url: link.url,
        title: link.title,
        category: link.category,
        selectedText: link.selectedText
      },
      blogFile: blogFile.path
    });

    // For now, we'll simulate success after a short delay
    await new Promise(resolve => setTimeout(resolve, 500));

    // In a real implementation, you might:
    // 1. Send the link data to a backend API
    // 2. The backend would read the blog file
    // 3. Find the appropriate category section
    // 4. Add the formatted link
    // 5. Save the file back
    // 6. Optionally commit to git

    // Always succeed (removed random failure simulation)
    const success = true;

    if (success) {
      // Show success notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: '../images/icon.png',
        title: 'Link Added to Blog',
        message: `Added "${link.title}" to your blog draft`
      });

      return { success: true };
    } else {
      throw new Error('Failed to add link to blog file');
    }
    
  } catch (error) {
    console.error('Error adding link to blog:', error);
    
    // Show error notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: '../images/icon.png',
      title: 'Blog Update Failed',
      message: 'Link saved locally, but could not update blog file'
    });

    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === '_execute_action') {
    // This will trigger the popup to open
    console.log('Keyboard shortcut triggered');
  }
});