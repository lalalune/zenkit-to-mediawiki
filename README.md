# Zenkit to MediaWiki Converter

This tool consists of two main scripts that convert Zenkit JSON exports to MediaWiki pages and then upload them to a MediaWiki instance.

## Prerequisites

- Node.js (version 14 or higher recommended)
- npm (comes with Node.js)
- Access to a MediaWiki instance with API capabilities
- Admin credentials for the MediaWiki instance

## Installation

1. Clone this repository or download the scripts
2. Install dependencies:
```bash
npm install fs path crypto axios axios-cookiejar-support tough-cookie form-data p-limit
```

## Directory Structure

Your directory should look like this:
```
project-root/
├── transform.mjs             # First script (Zenkit to MediaWiki converter)
├── upload.mjs               # Second script (MediaWiki uploader)
├── Guide_to_Emergence_1.0_Prototype.json  # Your Zenkit export
└── lists/                  # Directory containing your Zenkit files
    ├── List1/
    │   ├── List1.json
    │   └── Files/
    │       └── Items/
    └── List2/
        ├── List2.json
        └── Files/
            └── Items/
```

## Step 1: Convert Zenkit Export to MediaWiki Format

### Usage

```bash
node transform.mjs [input-json] [output-dir] [files-root-dir] [--erase=true]
```

### Parameters

- `input-json` (optional): Path to your Zenkit JSON export
  - Default: './Guide_to_Emergence_1.0_Prototype.json'
- `output-dir` (optional): Where to save the converted MediaWiki pages
  - Default: './mediawiki-pages'
- `files-root-dir` (optional): Root directory containing your Zenkit files
  - Default: './lists'
- `--erase=true` (optional): Erase existing output directory before conversion

### Example Commands

Basic usage (using defaults):
```bash
node transform.mjs
```

Specifying all parameters:
```bash
node transform.mjs ./my-zenkit-export.json ./wiki-pages ./my-lists --erase=true
```

## Step 2: Upload to MediaWiki

### Usage

```bash
node upload.mjs [mediawiki-dir] [api-url] [username] [password]
```

### Parameters

- `mediawiki-dir` (optional): Directory containing converted MediaWiki pages
  - Default: './mediawiki-pages'
- `api-url` (optional): URL to your MediaWiki API
  - Default: 'http://localhost:8080/w/api.php'
- `username` (optional): MediaWiki admin username
  - Default: 'Admin'
- `password` (optional): MediaWiki admin password
  - Default: 'dockerpass'

### Example Commands

Basic usage (using defaults):
```bash
node upload.mjs
```

Specifying all parameters:
```bash
node upload.mjs ./wiki-pages https://my-wiki.com/w/api.php admin password123
```

## Expected Output

After running both scripts:

1. The transformer will create:
   - A `mediawiki-pages` directory containing:
     - Text files for each wiki page
     - A `Media` directory with all attachments
     - Navigation and index pages

2. The uploader will:
   - Upload all files to your MediaWiki instance
   - Create navigation templates
   - Set up the main page and site structure
   - Show progress and completion statistics