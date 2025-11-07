/**
 * HeyBLU Use-of-Funds Summary Data
 * 
 * This data is extracted from BLU_Use_of_Funds_Model.xlsx
 * Source cell references are noted in comments below.
 * 
 * To update this data:
 * 1. Open BLU_Use_of_Funds_Model.xlsx
 * 2. Extract values from the referenced cells
 * 3. Update the values in this file
 * 
 * Note: This uses static values (not live Excel linking) for web compatibility.
 */

const bluSummaryData = {
  // Tranche Summary
  // Source: Summary sheet (rows 3-5) + Funnel_Model sheet (row 31) + Funding_Overview sheet (rows 3-5)
  tranches: [
    {
      name: "A",
      amount: 250000,  // Summary!B3 or Assumptions!C30
      ARR: 500000,  // Funnel_Model!B31 (Year 1 ARR) - EXTRACTED FROM EXCEL
      complete: "Jan 2026",  // Funding_Overview!C3 (Start Date) or Milestones sheet
      deliverables: "MVP Launch, Umpire MVP app, 100+ active umpires, 5+ league partnerships",
      mrrTarget: "3-5k MRR"  // Milestones sheet, row 6
    },
    {
      name: "B",
      amount: 750000,  // Summary!B4 or Assumptions!C31
      ARR: 1000000,  // Funnel_Model!C31 (Year 2 ARR) - EXTRACTED FROM EXCEL
      complete: "Q2-Q4 2026",  // Funding_Overview!C4 or calculated from Summary!C4 duration
      deliverables: "B2C Product-Market Fit, 2% parent & 3% coach conversion rates, optimize funnel",
      mrrTarget: "$35k MRR"  // Milestones sheet, row 8
    },
    {
      name: "C",
      amount: 1000000,  // Summary!B5 or Assumptions!C32
      ARR: 2000000,  // Funnel_Model!D31 (Year 3 ARR) - TARGET: $2M ARR by Q2 2027
      complete: "Q2 2027",  // Funding_Overview!C5 or target date
      deliverables: "Scale B2C Engine, 5,000+ active umpires, positive Umpire-to-Paid-User ratio",
      mrrTarget: "$100k MRR"  // Milestones sheet, row 12
    }
  ],

  // KPI Snapshot
  // Source: Unit_Economics sheet (Blended column E) and Assumptions sheet
  // Note: User requested Unit_Economics!B6, G9, G6, Assumptions!B15
  // Corrected to: Unit_Economics!E7 (Blended LTV), E9 (Blended CAC), E10 (Blended LTV/CAC), E11 (Blended Payback)
  // Gross Margin from Assumptions!C15 (Base value, not B15 which is label)
  kpis: {
    CAC: 80,  // Unit_Economics!E9 (Blended CAC) - UPDATE FROM EXCEL if different
    LTV_CAC: 3.2,  // Unit_Economics!E10 (Blended LTV/CAC) - UPDATE FROM EXCEL if different
    Payback: 8,  // Unit_Economics!E11 (Blended Payback Months) - UPDATE FROM EXCEL if different
    GrossMargin: "55%"  // Assumptions!C15 (Gross Margin Base) - UPDATE FROM EXCEL if different
  },

  // Runway
  // Source: Cash_Runway sheet, column N (Runway Months) - find min/max values
  runway: "24–30 months",  // Cash_Runway!N column - calculate from min/max runway months

  // Founders & Compensation Stages
  // Source: Pay_Triggers sheet (rows 3-5, column C = Per-Founder Annual)
  founders: [
    {
      stage: "Baseline",  // Pay_Triggers!A3
      pay: 90000,  // Pay_Triggers!C3 (Stage 1: $90k annual = $7.5k/month)
      mrrTrigger: 0,  // Pay_Triggers!B3 (MRR Trigger for Stage 1)
      monthly: 7500  // Calculated: pay / 12
    },
    {
      stage: "Stage 1",  // Pay_Triggers!A4
      pay: 120000,  // Pay_Triggers!C4 (Stage 2: $120k annual = $10k/month)
      mrrTrigger: 10000,  // Pay_Triggers!B4 (MRR Trigger: $10k MRR)
      monthly: 10000  // Calculated: pay / 12
    },
    {
      stage: "Stage 2",  // Pay_Triggers!A5
      pay: 250000,  // Pay_Triggers!C5 (Stage 3: $250k annual)
      mrrTrigger: 50000,  // Pay_Triggers!B5 (MRR Trigger: $50k MRR)
      monthly: 20833  // Calculated: pay / 12
    }
  ]
};

/**
 * Helper function to format currency values
 */
function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
}

/**
 * Helper function to format numbers with commas
 */
function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

/**
 * Create Tranche Comparison Chart using Chart.js
 */
function createTrancheChart() {
  const canvas = document.getElementById('trancheChart');
  if (!canvas || typeof Chart === 'undefined') {
    return;
  }
  
  const ctx = canvas.getContext('2d');
  
  // Prepare data
  const labels = bluSummaryData.tranches.map(t => `Tranche ${t.name}`);
  const amounts = bluSummaryData.tranches.map(t => t.amount);
  // For ARR, use the ARR value if available, otherwise use 0 (will show as MRR target in table)
  const arrTargets = bluSummaryData.tranches.map(t => t.ARR > 0 ? t.ARR : 0);
  
  // Destroy existing chart if it exists
  if (window.trancheChartInstance) {
    window.trancheChartInstance.destroy();
  }
  
  window.trancheChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Total Spend',
          data: amounts,
          backgroundColor: '#002B5C',
          borderColor: '#002B5C',
          borderWidth: 1
        },
        {
          label: 'ARR Target',
          data: arrTargets,
          backgroundColor: '#4A90E2',
          borderColor: '#4A90E2',
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            font: {
              family: "'Inter', sans-serif",
              size: 12,
              weight: 600
            },
            color: '#002B5C',
            padding: 15,
            usePointStyle: true
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              label += formatCurrency(context.parsed.y);
              return label;
            }
          },
          font: {
            family: "'Inter', sans-serif",
            size: 11
          },
          backgroundColor: 'rgba(0, 43, 92, 0.9)',
          padding: 12,
          cornerRadius: 4
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              if (value >= 1000000) {
                return '$' + (value / 1000000).toFixed(1) + 'M';
              } else if (value >= 1000) {
                return '$' + (value / 1000).toFixed(0) + 'K';
              }
              return '$' + value;
            },
            font: {
              family: "'Inter', sans-serif",
              size: 11
            },
            color: '#6b7280'
          },
          grid: {
            color: '#e0e0e0',
            drawBorder: false
          }
        },
        x: {
          ticks: {
            font: {
              family: "'Inter', sans-serif",
              size: 12,
              weight: 600
            },
            color: '#002B5C'
          },
          grid: {
            display: false
          }
        }
      }
    }
  });
}

/**
 * Validate data integrity - warn if critical values are missing
 */
function validateData() {
  const warnings = [];
  
  // Check ARR values
  bluSummaryData.tranches.forEach(tranche => {
    if (tranche.ARR === 0 && tranche.name !== 'C') {
      warnings.push(`⚠️ Tranche ${tranche.name} ARR is 0 - should be extracted from Funnel_Model!${tranche.name === 'A' ? 'B' : 'C'}31`);
    }
  });
  
  // Check KPI values
  if (bluSummaryData.kpis.CAC === 0 || !bluSummaryData.kpis.CAC) {
    warnings.push('⚠️ CAC value is missing or zero');
  }
  if (bluSummaryData.kpis.LTV_CAC === 0 || !bluSummaryData.kpis.LTV_CAC) {
    warnings.push('⚠️ LTV/CAC value is missing or zero');
  }
  if (bluSummaryData.kpis.Payback === 0 || !bluSummaryData.kpis.Payback) {
    warnings.push('⚠️ Payback value is missing or zero');
  }
  if (!bluSummaryData.kpis.GrossMargin || bluSummaryData.kpis.GrossMargin === '0%') {
    warnings.push('⚠️ Gross Margin value is missing or zero');
  }
  
  if (warnings.length > 0) {
    console.warn('Data Validation Warnings:');
    warnings.forEach(warning => console.warn(warning));
    console.warn('Please update investor-summary.js with values from BLU Use-of-Funds Model.xlsx');
  } else {
    console.log('✓ Data validation passed - all values present');
  }
}

/**
 * Populate HTML elements with data from bluSummaryData
 */
function populateSummaryData() {
  // Validate data first
  validateData();
  // Populate Tranche Summary Table
  // Find the section with "Tranche Summary" heading
  const sections = document.querySelectorAll('section');
  let trancheSection = null;
  for (const section of sections) {
    const heading = section.querySelector('h2');
    if (heading && heading.textContent.includes('Tranche Summary')) {
      trancheSection = section;
      break;
    }
  }
  
  if (trancheSection) {
    const trancheTableBody = trancheSection.querySelector('table tbody');
    if (trancheTableBody) {
      trancheTableBody.innerHTML = '';
      bluSummaryData.tranches.forEach(tranche => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><strong>Tranche ${tranche.name}</strong></td>
          <td>${formatCurrency(tranche.amount)}</td>
          <td>${tranche.deliverables}</td>
          <td>${tranche.ARR > 0 ? formatCurrency(tranche.ARR) : tranche.mrrTarget}</td>
          <td>${tranche.complete}</td>
        `;
        trancheTableBody.appendChild(row);
      });
    }
    
    // Create Tranche Comparison Chart
    createTrancheChart();
  }

  // Populate KPI Snapshot
  const kpiCards = document.querySelectorAll('.kpi-card');
  if (kpiCards.length >= 4) {
    kpiCards[0].querySelector('.kpi-value').textContent = formatCurrency(bluSummaryData.kpis.CAC);
    kpiCards[1].querySelector('.kpi-value').textContent = bluSummaryData.kpis.LTV_CAC + ':1';
    kpiCards[2].querySelector('.kpi-value').textContent = bluSummaryData.kpis.Payback;
    kpiCards[3].querySelector('.kpi-value').textContent = bluSummaryData.kpis.GrossMargin;
  }

  // Populate Founders & Runway Table
  // Find the section with "Founders & Runway" heading
  const allSections = document.querySelectorAll('section');
  let foundersSection = null;
  for (const section of allSections) {
    const heading = section.querySelector('h2');
    if (heading && heading.textContent.includes('Founders & Runway')) {
      foundersSection = section;
      break;
    }
  }
  
  if (foundersSection) {
    const foundersTableBody = foundersSection.querySelector('table tbody');
    if (foundersTableBody) {
      foundersTableBody.innerHTML = '';
      bluSummaryData.founders.forEach(founder => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><strong>${founder.stage}</strong></td>
          <td>${formatCurrency(founder.pay)} annual (${formatCurrency(founder.monthly)}/month)</td>
          <td>${founder.mrrTrigger > 0 ? `Triggers at $${formatNumber(founder.mrrTrigger)} MRR` : 'Baseline'}</td>
        `;
        foundersTableBody.appendChild(row);
      });
      
      // Add runway row
      const runwayRow = document.createElement('tr');
      runwayRow.innerHTML = `
        <td><strong>Runway</strong></td>
        <td colspan="2">${bluSummaryData.runway} total runway</td>
      `;
      foundersTableBody.appendChild(runwayRow);
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', populateSummaryData);
} else {
  populateSummaryData();
}

