# PDF Generation Guide

This directory contains scripts to convert `summary/investor-summary.html` to a PDF file.

## Output

The PDF will be saved as: `HeyBLU_Use_of_Funds_Summary.pdf`

## Methods

### Option 1: Using Puppeteer (Recommended)

Puppeteer provides the best rendering quality, especially for JavaScript-heavy pages with Chart.js.

#### Prerequisites
- Node.js installed
- Puppeteer package

#### Installation
```bash
cd use-of-funds
npm install puppeteer
```

#### Usage

**Bash script:**
```bash
./generate-pdf.sh
```

**Direct Node.js:**
```bash
node generate-pdf.js
```

### Option 2: Using wkhtmltopdf

A standalone binary that doesn't require Node.js.

#### Prerequisites
- wkhtmltopdf installed (download from https://wkhtmltopdf.org/downloads.html)

#### Usage
```bash
./generate-pdf.sh
```

The script will automatically try Puppeteer first, then fall back to wkhtmltopdf if Puppeteer is not available.

## Notes

- The script waits for Chart.js to render before generating the PDF
- Background colors and styles are preserved
- Output format: Letter size with 0.5" margins
- The HTML file must be accessible via file:// protocol

## Troubleshooting

If Puppeteer fails:
1. Ensure Node.js is installed: `node --version`
2. Install Puppeteer: `npm install puppeteer`
3. Check that the HTML file exists at `summary/investor-summary.html`

If wkhtmltopdf fails:
1. Ensure wkhtmltopdf is in your PATH: `wkhtmltopdf --version`
2. Install from: https://wkhtmltopdf.org/downloads.html

