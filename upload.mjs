import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import tough from 'tough-cookie';
import FormData from 'form-data';
import crypto from 'crypto';
import pLimit from 'p-limit';

wrapper(axios);
const cookieJar = new tough.CookieJar();

// Configuration
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000];
const MAX_RETRIES = 5;
const PAGE_UPLOAD_TIMEOUT = 30000;
const FILE_UPLOAD_TIMEOUT = 60000;
const RATE_LIMIT_DELAY = 100;
const CONCURRENT_OPERATIONS = 5;
const TOKEN_REFRESH_INTERVAL = 60000;

const limit = pLimit(CONCURRENT_OPERATIONS);
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Token management
let currentCSRFToken = null;
let lastTokenRefresh = 0;

async function withRetry(operation, name, maxRetries = MAX_RETRIES) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await operation();
      if (attempt > 0) {
        console.log(`Successfully completed ${name} after ${attempt + 1} attempts`);
      }
      return result;
    } catch (error) {
      lastError = error;
      
      if (error.response?.data?.error?.code === 'badtoken') {
        console.log('Invalid token detected, refreshing...');
        currentCSRFToken = await refreshCSRFToken();
        continue;
      }

      const isRetryable = error.response?.status >= 500 || 
                         error.code === 'ECONNRESET' ||
                         error.code === 'ETIMEDOUT';
      
      if (!isRetryable && error.response?.status !== undefined) {
        console.error(`Non-retryable error for ${name}:`, error.message);
        throw error;
      }

      if (attempt < maxRetries - 1) {
        const delayTime = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        console.log(`Attempt ${attempt + 1} failed for ${name}. Retrying in ${delayTime/1000} seconds...`);
        await delay(delayTime);
      } else {
        console.error(`All ${maxRetries} attempts failed for ${name}. Last error:`, error.message);
        throw lastError;
      }
    }
  }
}

const WMAPI = {
  login: async function(apiUrl, username, password) {
    return withRetry(async () => {
      const tokenResponse = await axios.get(`${apiUrl}?action=query&meta=tokens&type=login&format=json`, {
        jar: cookieJar,
        withCredentials: true
      });
      const loginToken = tokenResponse.data.query.tokens.logintoken;

      const loginResponse = await axios.post(apiUrl, new URLSearchParams({
        action: 'login',
        format: 'json',
        lgname: username,
        lgpassword: password,
        lgtoken: loginToken
      }), {
        jar: cookieJar,
        withCredentials: true,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      if (loginResponse.data.login.result !== 'Success') {
        throw new Error(`Login failed: ${loginResponse.data.login.reason}`);
      }

      return loginResponse.data;
    }, 'login');
  },

  getCSRFToken: async function(apiUrl, force = false) {
    const now = Date.now();
    if (!force && currentCSRFToken && (now - lastTokenRefresh) < TOKEN_REFRESH_INTERVAL) {
      return currentCSRFToken;
    }

    return withRetry(async () => {
      const response = await axios.get(`${apiUrl}?action=query&meta=tokens&format=json`, {
        jar: cookieJar,
        withCredentials: true
      });
      currentCSRFToken = response.data.query.tokens.csrftoken;
      lastTokenRefresh = now;
      return currentCSRFToken;
    }, 'get CSRF token');
  },

  getPageContent: async function(apiUrl, pageTitle) {
    return withRetry(async () => {
      const response = await axios.get(`${apiUrl}?action=query&prop=revisions&titles=${encodeURIComponent(pageTitle)}&rvprop=content&format=json`, {
        jar: cookieJar,
        withCredentials: true
      });
      
      const pages = response.data.query.pages;
      const pageId = Object.keys(pages)[0];
      
      if (pageId === '-1') return null;
      
      const revisions = pages[pageId].revisions;
      return revisions ? revisions[0]['*'] : null;
    }, `get page content: ${pageTitle}`);
  },

  getFileInfo: async function(apiUrl, filename) {
    return withRetry(async () => {
      const response = await axios.get(`${apiUrl}?action=query&prop=imageinfo&titles=File:${encodeURIComponent(filename)}&iiprop=sha1|size&format=json`, {
        jar: cookieJar,
        withCredentials: true
      });
      
      const pages = response.data.query.pages;
      const pageId = Object.keys(pages)[0];
      
      if (pageId === '-1') return null;
      
      return pages[pageId].imageinfo ? pages[pageId].imageinfo[0] : null;
    }, `get file info: ${filename}`);
  },

  calculateFileSHA1: function(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha1');
      const stream = fs.createReadStream(filePath);
      
      stream.on('error', err => reject(err));
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  },

  uploadPage: async function(apiUrl, csrfToken, pageTitle, pageContent) {
    return withRetry(async () => {
      const response = await axios.post(apiUrl, new URLSearchParams({
        action: 'edit',
        format: 'json',
        title: pageTitle,
        text: pageContent,
        token: csrfToken,
        bot: '1'
      }), {
        jar: cookieJar,
        withCredentials: true,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: PAGE_UPLOAD_TIMEOUT
      });
      return response.data;
    }, `upload page: ${pageTitle}`);
  },

  uploadFile: async function(apiUrl, csrfToken, filePath, filename) {
    return withRetry(async () => {
      const formData = new FormData();
      formData.append('action', 'upload');
      formData.append('format', 'json');
      formData.append('filename', filename);
      formData.append('token', csrfToken);
      formData.append('ignorewarnings', '1');
      formData.append('file', fs.createReadStream(filePath));

      const response = await axios.post(apiUrl, formData, {
        jar: cookieJar,
        withCredentials: true,
        headers: {
          ...formData.getHeaders(),
          'Content-Length': formData.getLengthSync()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: FILE_UPLOAD_TIMEOUT
      });

      return response.data;
    }, `upload file: ${filename}`);
  }
};

async function refreshCSRFToken(apiUrl) {
  return await WMAPI.getCSRFToken(apiUrl, true);
}

async function createListPages(apiUrl, csrfToken, structure, mediawikiDir) {
  for (const [listName, pages] of Object.entries(structure)) {
    let pageContent = `= ${listName.replace(/_/g, ' ')} =\n\n`;
    pageContent += `{{Navigation}}\n\n`;
    
    // Add list description if it exists
    const listJsonPath = path.join(mediawikiDir, listName, `${listName}.json`);
    if (fs.existsSync(listJsonPath)) {
      try {
        const listData = JSON.parse(fs.readFileSync(listJsonPath, 'utf8'));
        if (listData.list && listData.list.description) {
          pageContent += `${listData.list.description}\n\n`;
        }
      } catch (error) {
        console.error(`Error reading list description for ${listName}:`, error.message);
      }
    }

    // Add pages section
    pageContent += '== Pages in this Section ==\n\n';
    pages.sort((a, b) => a.localeCompare(b)).forEach(page => {
      pageContent += `* [[${listName}/${page}|${page.replace(/_/g, ' ')}]]\n`;
    });

    await WMAPI.uploadPage(apiUrl, csrfToken, listName, pageContent);
    console.log(`✓ Created list page for ${listName}`);
  }
}

async function createListIndex(apiUrl, csrfToken, structure) {
  let indexContent = `= Guide to Emergence Lists =\n\n`;
  indexContent += `{{Navigation}}\n\n`;
  indexContent += `This page provides quick access to all major sections of the Guide to Emergence.\n\n`;
  
  const lists = Object.keys(structure)
    .filter(name => name !== 'Homepage')
    .sort((a, b) => a.localeCompare(b));
  
  for (const listName of lists) {
    const pageCount = structure[listName].length;
    indexContent += `* [[${listName}|${listName.replace(/_/g, ' ')}]] (${pageCount} pages)\n`;
  }

  await WMAPI.uploadPage(apiUrl, csrfToken, 'Lists', indexContent);
  console.log('✓ Created Lists index page');
}

async function createNavigationTemplate(apiUrl, csrfToken) {
  const templateContent = `<div class="main-navigation">
{| class="wikitable" style="width: 100%; background-color: #f8f9fa; margin: 1em 0;"
|-
| style="padding: 1em;" |
* [[Main Page|Home]]
* [[Lists|All Lists]]
* [[Site Map|Site Map]]
|}
</div>`;

  await WMAPI.uploadPage(apiUrl, csrfToken, 'Template:Navigation', templateContent);
  console.log('✓ Created navigation template');
}

async function createSidebarNavigation(apiUrl, csrfToken, structure) {
  const sidebarContent = `* navigation
** mainpage|Home
** Lists|All Lists
** Site Map|Site Map
* Lists
${Object.keys(structure)
  .filter(name => name !== 'Homepage')
  .sort()
  .map(name => `** ${name}|${name.replace(/_/g, ' ')}`)
  .join('\n')}`;

  await WMAPI.uploadPage(apiUrl, csrfToken, 'MediaWiki:Sidebar', sidebarContent);
  console.log('✓ Created sidebar navigation');
}

async function createSiteMap(apiUrl, csrfToken, structure) {
  let siteMapContent = `= Guide to Emergence Site Map =\n\n`;
  siteMapContent += `{{Navigation}}\n\n`;
  
  const lists = Object.keys(structure)
    .filter(name => name !== 'Homepage')
    .sort((a, b) => a.localeCompare(b));
  
  for (const listName of lists) {
    siteMapContent += `== ${listName.replace(/_/g, ' ')} ==\n`;
    const pages = structure[listName].sort((a, b) => a.localeCompare(b));
    pages.forEach(page => {
      siteMapContent += `* [[${listName}/${page}|${page.replace(/_/g, ' ')}]]\n`;
    });
    siteMapContent += '\n';
  }

  await WMAPI.uploadPage(apiUrl, csrfToken, 'Site Map', siteMapContent);
  console.log('✓ Created site map');
}

// Process individual files and pages
async function processFile(apiUrl, csrfToken, filePath, listDir, mediaFile, stats) {
  return limit(async () => {
    const destFilename = `${listDir}/${mediaFile}`;
    try {
      const existingFile = await WMAPI.getFileInfo(apiUrl, destFilename);
      const localSHA1 = await WMAPI.calculateFileSHA1(filePath);
      
      if (existingFile && existingFile.sha1 === localSHA1) {
        console.log(`⏭ Skipping file "${mediaFile}" - identical file exists`);
        stats.filesSkipped++;
        return;
      }

      console.log(`↑ Uploading file: ${mediaFile}`);
      const uploadResult = await WMAPI.uploadFile(apiUrl, currentCSRFToken, filePath, destFilename);
      
      if (uploadResult.upload && uploadResult.upload.result === 'Success') {
        console.log(`✓ File "${mediaFile}" uploaded successfully`);
        stats.filesUploaded++;
      } else {
        console.error(`✗ Failed to upload file "${mediaFile}"`, uploadResult);
        stats.errors++;
      }
    } catch (error) {
      console.error(`✗ Error processing file "${mediaFile}":`, error.message);
      stats.errors++;
    }
  });
}

async function processPage(apiUrl, csrfToken, pagePath, listDir, pageFile, stats, wikiStructure) {
  return limit(async () => {
    const pageTitle = `${listDir}/${path.parse(pageFile).name}`;
    const localContent = fs.readFileSync(pagePath, 'utf8');

    try {
      const existingContent = await WMAPI.getPageContent(apiUrl, pageTitle);
      
      if (existingContent === localContent) {
        console.log(`⏭ Skipping page "${pageTitle}" - identical content exists`);
        stats.pagesSkipped++;
        return;
      }

      console.log(`↑ ${existingContent ? 'Updating' : 'Creating'} page: ${pageTitle}`);
      const uploadResult = await WMAPI.uploadPage(apiUrl, currentCSRFToken, pageTitle, localContent);
      
      if (uploadResult.edit && uploadResult.edit.result === 'Success') {
        console.log(`✓ Page "${pageTitle}" ${existingContent ? 'updated' : 'created'} successfully`);
        stats.pagesUploaded++;
        
        if (!wikiStructure[listDir]) wikiStructure[listDir] = [];
        if (!wikiStructure[listDir].includes(path.parse(pageFile).name)) {
          wikiStructure[listDir].push(path.parse(pageFile).name);
        }
      } else {
        console.error(`✗ Failed to ${existingContent ? 'update' : 'create'} page "${pageTitle}"`, uploadResult);
        stats.errors++;
      }
    } catch (error) {
      console.error(`✗ Error processing page "${pageTitle}":`, error.message);
      stats.errors++;
    }
  });
}

async function uploadMediaWikiFiles(mediawikiDir, apiUrl, username, password, options = {}) {
  const stats = {
    filesProcessed: 0,
    filesUploaded: 0,
    filesSkipped: 0,
    pagesProcessed: 0,
    pagesUploaded: 0,
    pagesSkipped: 0,
    errors: 0
  };

  const wikiStructure = {};
  const allLists = [];

  try {
    console.log('Starting MediaWiki upload process...');
    
    await WMAPI.login(apiUrl, username, password);
    console.log('✓ Login successful');

    currentCSRFToken = await WMAPI.getCSRFToken(apiUrl);
    console.log('✓ CSRF token obtained');

    // Start token refresh interval
    const tokenRefreshInterval = setInterval(async () => {
      try {
        currentCSRFToken = await refreshCSRFToken(apiUrl);
        console.log('✓ CSRF token refreshed');
      } catch (error) {
        console.error('Failed to refresh CSRF token:', error.message);
      }
    }, TOKEN_REFRESH_INTERVAL);

    // Process media files
    const mediaDir = path.join(mediawikiDir, 'Media');
    if (fs.existsSync(mediaDir)) {
      const filePromises = [];
      const listDirs = fs.readdirSync(mediaDir);

      for (const listDir of listDirs) {
        const listPath = path.join(mediaDir, listDir);
        if (fs.statSync(listPath).isDirectory()) {
          console.log(`\nProcessing media files for ${listDir}`);
          const mediaFiles = fs.readdirSync(listPath);
          
          for (const mediaFile of mediaFiles) {
            stats.filesProcessed++;
            const filePath = path.join(listPath, mediaFile);
            filePromises.push(processFile(apiUrl, currentCSRFToken, filePath, listDir, mediaFile, stats));
            await delay(RATE_LIMIT_DELAY);
          }
        }
      }

      await Promise.all(filePromises);
    }

    // Process pages
    const pagePromises = [];
    const listDirs = fs.readdirSync(mediawikiDir);

    for (const listDir of listDirs) {
      if (listDir === 'Media') continue;
      
      if (!allLists.includes(listDir)) {
        allLists.push(listDir);
      }
      wikiStructure[listDir] = [];
      
      const listPath = path.join(mediawikiDir, listDir);
      if (fs.statSync(listPath).isDirectory()) {
        console.log(`\nProcessing pages for ${listDir}`);
        const pageFiles = fs.readdirSync(listPath);
        
        for (const pageFile of pageFiles) {
          if (pageFile.endsWith('.txt') || pageFile.endsWith('.md')) {
            stats.pagesProcessed++;
            const pagePath = path.join(listPath, pageFile);
            pagePromises.push(processPage(apiUrl, currentCSRFToken, pagePath, listDir, pageFile, stats, wikiStructure));
            await delay(RATE_LIMIT_DELAY);
          }
        }
      }
    }

    await Promise.all(pagePromises);

    // Clean up token refresh interval
    clearInterval(tokenRefreshInterval);

    // Create navigation and organization pages
    console.log('\nCreating navigation and organization pages...');
    await createNavigationTemplate(apiUrl, currentCSRFToken);
    await createSiteMap(apiUrl, currentCSRFToken, wikiStructure);
    await createListPages(apiUrl, currentCSRFToken, wikiStructure, mediawikiDir);
    await createListIndex(apiUrl, currentCSRFToken, wikiStructure);
    await createSidebarNavigation(apiUrl, currentCSRFToken, wikiStructure);

    // Set up homepage
    if (wikiStructure['Homepage']) {
      const homepageContent = await WMAPI.getPageContent(apiUrl, 'Homepage/Homepage');
      if (homepageContent) {
        // Add navigation template to the homepage content
        const mainPageContent = `{{Navigation}}\n\n${homepageContent}`;
        await WMAPI.uploadPage(apiUrl, currentCSRFToken, 'Main Page', mainPageContent);
        console.log('✓ Main page created successfully');
      }
    }

    console.log('\nUpload process completed:');
    console.log(`Files: ${stats.filesUploaded} uploaded, ${stats.filesSkipped} skipped, ${stats.filesProcessed} total`);
    console.log(`Pages: ${stats.pagesUploaded} uploaded, ${stats.pagesSkipped} skipped, ${stats.pagesProcessed} total`);
    console.log(`Errors: ${stats.errors}`);

    return stats;
  } catch (error) {
    console.error('Fatal error:', error.message);
    throw error;
  }
}

// CLI handling
if (import.meta.url === import.meta.url) {
  const mediawikiDir = process.argv[2] || './mediawiki-pages';
  const apiUrl = process.argv[3] || 'http://localhost:8080/w/api.php';
  const username = process.argv[4] || 'Admin';
  const password = process.argv[5] || 'dockerpass';

  uploadMediaWikiFiles(mediawikiDir, apiUrl, username, password)
    .then((stats) => {
      console.log('\nProcess completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\nProcess failed:', error.message);
      process.exit(1);
    });
}

export { uploadMediaWikiFiles, WMAPI };