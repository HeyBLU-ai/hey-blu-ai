# BLU Use-of-Funds Financial Model

This Python script generates a comprehensive Excel financial model for BLU's use of funds across three funding tranches.

## Setup

1. **Install Python dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

2. **Run the script:**
   ```bash
   python generate_model.py
   ```

   This will generate `BLU Use-of-Funds Model.xlsx` in the current directory.

## Usage

The generated Excel file contains 13 sheets:

- **README**: Instructions for using the model
- **Assumptions**: All key inputs (cells in blue are editable)
- **Summary**: Funding tranche overview
- **Tranche_Detail**: Detailed use of funds breakdown
- **County_League_Model**: User growth and ARR projections
- **Unit_Economics**: LTV, CAC, and payback calculations
- **Cash_Runway**: Monthly cash flow and runway analysis
- **Pay_Triggers**: Founder compensation milestones
- **Milestones**: KPI tracking and tranche triggers
- **Scenarios**: Conservative, Base, and Aggressive assumptions
- **Scenarios_Output**: Summary of scenario outcomes
- **Sales_Comp**: Sales team compensation structure
- **Infra_Estimates**: Infrastructure cost estimates

## Notes

- Blue cells with light blue backgrounds are **input cells** - modify these to test different scenarios
- All other cells contain formulas and update automatically
- The model is designed to be shared with investors via the `/use-of-funds` route

