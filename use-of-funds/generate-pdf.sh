#!/bin/bash

# Script to convert investor-summary.html to PDF
# Uses Puppeteer (via Node.js) or wkhtmltopdf

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUMMARY_DIR="$SCRIPT_DIR/summary"
HTML_FILE="$SUMMARY_DIR/investor-summary.html"
OUTPUT_PDF="$SCRIPT_DIR/HeyBLU_Use_of_Funds_Summary.pdf"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Converting investor-summary.html to PDF..."
echo "Input:  $HTML_FILE"
echo "Output: $OUTPUT_PDF"
echo ""

# Check if HTML file exists
if [ ! -f "$HTML_FILE" ]; then
    echo -e "${RED}Error: HTML file not found at $HTML_FILE${NC}"
    exit 1
fi

# Function to convert using Puppeteer
convert_with_puppeteer() {
    echo -e "${YELLOW}Attempting conversion with Puppeteer...${NC}"
    
    # Check if Node.js is available
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Node.js not found. Skipping Puppeteer.${NC}"
        return 1
    fi
    
    # Use the standalone Node.js script if it exists
    NODE_SCRIPT="$SCRIPT_DIR/generate-pdf.js"
    if [ -f "$NODE_SCRIPT" ]; then
        cd "$SCRIPT_DIR"
        if node "$NODE_SCRIPT" 2>/dev/null; then
            echo -e "${GREEN}✓ PDF generated successfully using Puppeteer${NC}"
            return 0
        fi
    fi
    
    # Fallback: Check if puppeteer is installed
    if ! node -e "require('puppeteer')" 2>/dev/null; then
        echo -e "${YELLOW}Puppeteer not installed. Installing...${NC}"
        cd "$SCRIPT_DIR"
        npm install puppeteer --save-dev 2>/dev/null || {
            echo -e "${RED}Failed to install Puppeteer.${NC}"
            return 1
        }
    fi
    
    # Run the standalone script
    cd "$SCRIPT_DIR"
    if node "$NODE_SCRIPT"; then
        echo -e "${GREEN}✓ PDF generated successfully using Puppeteer${NC}"
        return 0
    else
        return 1
    fi
}

# Function to convert using wkhtmltopdf
convert_with_wkhtmltopdf() {
    echo -e "${YELLOW}Attempting conversion with wkhtmltopdf...${NC}"
    
    # Check if wkhtmltopdf is available
    if ! command -v wkhtmltopdf &> /dev/null; then
        echo -e "${RED}wkhtmltopdf not found.${NC}"
        return 1
    fi
    
    # Convert HTML to PDF
    if wkhtmltopdf \
        --page-size Letter \
        --margin-top 0.5in \
        --margin-right 0.5in \
        --margin-bottom 0.5in \
        --margin-left 0.5in \
        --enable-local-file-access \
        --print-media-type \
        --no-outline \
        "$HTML_FILE" \
        "$OUTPUT_PDF" 2>/dev/null; then
        echo -e "${GREEN}✓ PDF generated successfully using wkhtmltopdf${NC}"
        return 0
    else
        return 1
    fi
}

# Try Puppeteer first (better JavaScript support)
if convert_with_puppeteer; then
    exit 0
fi

echo ""
echo -e "${YELLOW}Puppeteer conversion failed. Trying wkhtmltopdf...${NC}"
echo ""

# Fall back to wkhtmltopdf
if convert_with_wkhtmltopdf; then
    exit 0
fi

# If both fail
echo -e "${RED}Error: Failed to convert HTML to PDF${NC}"
echo ""
echo "Please install one of the following:"
echo "  1. Node.js and Puppeteer: npm install puppeteer"
echo "  2. wkhtmltopdf: https://wkhtmltopdf.org/downloads.html"
exit 1

