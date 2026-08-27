# Squirrel Link Collector - Chrome Extension

A Chrome browser extension for collecting links for your blog, built with React.

## Features

- 🐿️ Chrome extension (Manifest V3) for quick link collection
- ⚛️ Built with React 18 and modern JavaScript
- 🎨 Clean UI with Bulma CSS framework
- 🔗 Automatic URL sanitization (removes tracking parameters)
- 📋 One-click markdown link copying
- 🏷️ Categorized link organization

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Build the extension:**
   ```bash
   npm run build
   ```
   
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

3. **Load the extension in Chrome:**
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `dist` folder

## Usage

### Using the Extension
1. Click the Squirrel icon in your browser toolbar (or press `Ctrl+Shift+F`)
2. The popup will auto-populate with the current page's title and URL
3. Select a category for the link
4. Add an optional description
5. Click "Save Bookmark" to copy the markdown link to your clipboard

### Categories
- ⭐ **My favorites**: Your top picks
- 🎯 **Agile, Leadership and Product**: Management and product development
- 💻 **Architecture, Development & Software development practices**: Technical articles
- 🔧 **DevOps, Observability & Security**: Operations and security topics
- 🛠️ **Tools and things from Github**: Useful open-source projects

### Markdown Format
Links are formatted for Jekyll blogs with target="_blank":
```markdown
- [Article Title](https://example.com/article){:target="_blank"}
```

## Development

### Project Structure
```
squirrel/
├── src/
│   ├── popup/          # React popup interface
│   │   ├── index.js
│   │   ├── popup.html
│   │   └── popup.css
│   ├── components/     # React components
│   │   ├── App.jsx
│   │   └── BookmarkForm.jsx
│   ├── background.js   # Extension background script
│   ├── content.js      # Content script for page interaction
│   └── manifest.json   # Chrome extension manifest
├── images/             # Extension icons
├── dist/              # Built extension (git ignored)
└── webpack.config.js  # Build configuration
```

### Technologies
- React 18 for the popup UI
- Webpack 5 for building
- Babel for JSX compilation
- Chrome Extension Manifest V3
- Bulma CSS framework

### Building
The build process:
1. Compiles React/JSX to JavaScript
2. Bundles all scripts with Webpack
3. Copies manifest and images to dist/
4. Outputs a ready-to-use Chrome extension

## Next Steps

To integrate with your Jekyll blog workflow:
1. Use the web server component (see server.js) to automatically commit to GitHub
2. Or manually paste the copied markdown links into your blog posts
3. Consider adding a sync feature to save links to a backend service

## Migration from Vue
This is a React-based rewrite of the original Vue.js extension. Key improvements:
- Updated to Chrome Manifest V3
- Modern React 18 with hooks
- Simplified state management
- Better URL sanitization
- Cleaner build process