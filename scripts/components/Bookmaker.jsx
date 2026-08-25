import React, { useState, useEffect } from 'react';

const Bookmaker = () => {
    const [loggedIn, setLoggedIn] = useState(false);
    const [title, setTitle] = useState('');
    const [url, setUrl] = useState('');
    const [link, setLink] = useState('');
    const [category, setCategory] = useState('');
    const [description, setDescription] = useState('?');
    
    const categories = [
        "What i really liked",
        "Ideas, Thoughts and process",
        "Software development",
        "C#",
        "Javascript",
        "Other Languages",
        "Html, CSS, CSS preprocessors and all thing designy",
        "Tools",
        "Cloud, DevOps and Security",
        "Containers",
        "Machine Learning and other very fancy buzzwords",
        "Videos",
        "Made me Laugh or Cry. "
    ];

    // Utility functions
    const sanitizeUrl = (url) => {
        return url.replace(/&/g, '&amp;');
    };

    const toTitleCase = (str) => {
        return str.replace(/\w\S*/g, (txt) => {
            return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
        });
    };

    useEffect(() => {
        // Check if user is logged in
        if (chrome.identity) {
            chrome.identity.getProfileUserInfo((user) => {
                if (user && user.id) {
                    setLoggedIn(true);
                }
            });
        }

        // Get page details - Manifest V3 doesn't support getBackgroundPage
        // Instead, we'll get the active tab info directly
        if (chrome.tabs) {
            chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                if (tabs[0]) {
                    // Try to inject content script and get selection
                    chrome.scripting.executeScript({
                        target: { tabId: tabs[0].id },
                        func: () => {
                            return {
                                title: document.title,
                                url: window.location.href,
                                summary: window.getSelection().toString()
                            };
                        }
                    }).then((results) => {
                        if (results && results[0] && results[0].result) {
                            const pageDetails = results[0].result;
                            const pageTitle = pageDetails.summary || pageDetails.title;
                            const pageUrl = sanitizeUrl(pageDetails.url);
                            
                            setTitle(pageTitle);
                            setUrl(pageUrl);
                            setLink(`[${toTitleCase(pageTitle.replace("|", "-"))}](${pageUrl}){:target="_blank"}`);
                            setDescription(`* ${pageTitle} - ${pageDetails.url}`);
                        }
                    }).catch((err) => {
                        // Fallback to basic tab info
                        const pageTitle = tabs[0].title;
                        const pageUrl = sanitizeUrl(tabs[0].url);
                        
                        setTitle(pageTitle);
                        setUrl(pageUrl);
                        setLink(`[${toTitleCase(pageTitle.replace("|", "-"))}](${pageUrl}){:target="_blank"}`);
                        setDescription(`* ${pageTitle} - ${tabs[0].url}`);
                    });
                }
            });
        }
    }, []);

    const handleSave = () => {
        const model = {
            url: url,
            description: description,
            title: title,
            category: category
        };
        
        // TODO: Implement save functionality
        console.log('Saving bookmark:', model);
        
        // Show success message
        const statusDisplay = document.getElementById('status-display');
        if (statusDisplay) {
            statusDisplay.textContent = 'Bookmark saved!';
            setTimeout(() => {
                statusDisplay.textContent = '';
            }, 3000);
        }
    };

    return (
        <div id="addbookmark">
            <p className="control">
                <input 
                    className="input is-medium" 
                    type="text" 
                    id="title" 
                    name="title" 
                    size="50" 
                    placeholder="Title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                />
            </p>
            <p className="control">
                <input 
                    className="input is-medium" 
                    type="text" 
                    id="url" 
                    name="url" 
                    size="50"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                />
            </p>
            <p className="control">
                <select 
                    id="type" 
                    className="select is-medium"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                >
                    <option value="">Select a category</option>
                    {categories.map((cat, index) => (
                        <option key={index} value={cat}>{cat}</option>
                    ))}
                </select>
            </p>
            <p className="control">
                <textarea 
                    id="description" 
                    name="description" 
                    className="textarea is-medium"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                />
            </p>
            <p className="control">
                <input 
                    type="text" 
                    id="link" 
                    className="input is-medium"
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    autoFocus
                />
            </p>
            <p className="control">
                <input 
                    id="save" 
                    type="submit" 
                    value="Save" 
                    className="button is-primary is-medium"
                    onClick={handleSave}
                />
                <span id="status-display"></span>
                <span id="output"></span>
            </p>
            <style jsx>{`
                html,
                body {
                    height: 500px;
                    width: 400px;
                }
            `}</style>
        </div>
    );
};

export default Bookmaker;