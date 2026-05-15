# Squirrel Browser Extension 2025

A modern browser extension for collecting and organizing links with automatic blog draft updates. Built with React, TypeScript, and React Query.

## Features

- 🐿️ **Modern UI**: Clean, responsive interface with React and Tailwind CSS
- 🔄 **React Query Integration**: Efficient data fetching and caching
- 📝 **Automatic Blog Updates**: Directly updates your Jekyll blog drafts
- 📂 **Category Management**: Organize links by predefined categories
- 💾 **Local Storage**: Save links locally even when offline
- ⌨️ **Keyboard Shortcut**: Quick access via `Ctrl+Shift+F`
- 🎯 **Smart Text Selection**: Uses selected text as link title when available

## Installation

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Build the Extension**:
   ```bash
   npm run build
   ```

3. **Load in Chrome**:
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `dist` folder

## Usage

### Basic Link Collection

1. Navigate to any webpage
2. Click the Squirrel extension icon or press `Ctrl+Shift+F`
3. The extension will automatically populate:
   - Page URL
   - Page title
   - Selected text (if any)
4. Choose a category and blog file
5. Click "Add Link"

### Blog Integration

The extension can automatically update your Jekyll blog drafts located at:
```
/home/mlu/Documents/project/magudb.github.io/_drafts
```

#### Option 1: Backend Service (Recommended)

1. **Start the backend service**:
   ```bash
   npm run backend
   ```
   This starts a local Node.js service on `http://localhost:3001`

2. The extension will automatically use the backend for:
   - Reading blog files
   - Adding links to appropriate sections
   - Maintaining category organization

#### Option 2: Extension-Only Mode

If the backend service is not running, the extension will:
- Save links locally in browser storage
- Show fallback category and file options
- Allow manual copy of formatted markdown

### Categories

The extension supports these predefined categories:
- **My favorites** (`favorites`)
- **Agile, Leadership and Product** (`agile`)
- **Architecture, Development & Software development practices** (`development`)
- **DevOps, Observability & Security** (`devops`)
- **Tools and things from Github** (`tools`)

### Link Format

Links are formatted as markdown with Jekyll target attributes:
```markdown
- [Link Title](https://example.com){:target="_blank"}
```

If text is selected on the page, it will be used instead of the page title:
```markdown
- [Selected Text](https://example.com){:target="_blank"}
```

## Development

### Project Structure

```
src/
├── components/          # React components
│   ├── LinkForm.tsx    # Main form for adding links
│   └── SavedLinks.tsx  # Display saved links
├── hooks/              # React Query hooks
│   ├── useBlogData.ts  # Data fetching hooks
│   └── useBlogMutation.ts # Data mutation hooks
├── types/              # TypeScript type definitions
├── utils/              # Utility functions
│   └── blogService.ts  # Blog integration service
├── App.tsx             # Main React app
├── main.tsx           # React entry point
├── background.ts      # Extension background script
├── content.ts         # Content script
├── blogBackend.js     # Node.js backend service
└── index.css          # Tailwind CSS styles
```

### Development Commands

- **Development build**: `npm run dev`
- **Production build**: `npm run build`
- **Type checking**: `npm run type-check`
- **Backend service**: `npm run backend`

### Chrome Extension Architecture

- **Manifest V3**: Uses modern service worker instead of background pages
- **Content Script**: Injects into all pages to capture selected text
- **Popup**: React-based UI for link management
- **Background Service Worker**: Handles cross-page messaging and notifications

## Comparison with squirrel-mac

The original squirrel-mac project used:
- Python scripts with AppleScript dialogs
- Shell scripts for Chrome integration
- Direct file manipulation

This 2025 version offers:
- Modern web technologies (React, TypeScript)
- Better error handling and fallbacks
- Improved user experience
- Cross-platform compatibility potential
- Better maintainability

## Blog File Structure

The extension expects blog files to have Jekyll front matter with:
```yaml
---
category: "Curated Insights"
title: "Your Blog Post Title"
---
```

And category sections marked with:
```html
## Category Name<a name="category-anchor"></a>
```

## Troubleshooting

### Extension Not Loading
- Ensure you've run `npm run build`
- Check browser console for errors
- Verify manifest.json is valid

### Blog Updates Not Working
- Check if backend service is running (`npm run backend`)
- Verify blog file paths in `blogBackend.js`
- Check browser console for API errors

### Permission Issues
- Extension needs `activeTab` permission to read page content
- Backend service needs file system access to blog directory

## Future Enhancements

- [ ] Custom category management
- [ ] Batch link import/export
- [ ] Search and filter saved links
- [ ] Integration with more blog platforms
- [ ] Sync across devices
- [ ] Link validation and metadata extraction

## License

ISC License - see original repository for details.