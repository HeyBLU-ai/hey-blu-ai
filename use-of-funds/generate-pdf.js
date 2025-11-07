#!/usr/bin/env node

/**
 * Convert investor-summary.html to PDF using Puppeteer
 * Usage: node generate-pdf.js
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SCRIPT_DIR = __dirname;
const HTML_FILE = path.join(SCRIPT_DIR, 'summary', 'investor-summary.html');
const OUTPUT_PDF = path.join(SCRIPT_DIR, 'HeyBLU_Use_of_Funds_Summary.pdf');

// Check if HTML file exists
if (!fs.existsSync(HTML_FILE)) {
    console.error(`Error: HTML file not found at ${HTML_FILE}`);
    process.exit(1);
}

// Convert file path to file:// URL
const htmlPath = path.resolve(HTML_FILE);
const fileUrl = `file://${htmlPath.replace(/\\/g, '/')}`;

console.log('Converting investor-summary.html to PDF...');
console.log(`Input:  ${HTML_FILE}`);
console.log(`Output: ${OUTPUT_PDF}`);
console.log('');

(async () => {
    try {
        console.log('Launching browser...');
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();
        
        // Set viewport for consistent rendering
        await page.setViewport({
            width: 1200,
            height: 1600,
            deviceScaleFactor: 2
        });
        
        console.log(`Loading: ${fileUrl}`);
        await page.goto(fileUrl, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });
        
        // Wait for Chart.js to render (if present)
        console.log('Waiting for charts to render...');
        await page.waitForTimeout(3000);
        
        // Wait for any dynamic content
        await page.evaluate(() => {
            return new Promise((resolve) => {
                if (document.readyState === 'complete') {
                    resolve();
                } else {
                    window.addEventListener('load', resolve);
                }
            });
        });
        
        console.log('Generating PDF...');
        await page.pdf({
            path: OUTPUT_PDF,
            format: 'Letter',
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in'
            },
            preferCSSPageSize: false
        });
        
        await browser.close();
        
        console.log('');
        console.log(`✓ PDF generated successfully: ${OUTPUT_PDF}`);
        process.exit(0);
    } catch (error) {
        console.error('Error generating PDF:', error.message);
        process.exit(1);
    }
})();

