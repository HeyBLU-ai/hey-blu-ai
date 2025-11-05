import openpyxl

from openpyxl import Workbook

from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

from openpyxl.utils import get_column_letter

from openpyxl.formatting.rule import ColorScaleRule

from datetime import datetime



# --- Helper Functions for Styling ---

def setup_workbook():

    """Creates the workbook and all 13 required sheets."""

    wb = Workbook()

    

    # Rename default sheet

    ws_readme = wb.active

    ws_readme.title = "README"

    

    # Create all other sheets in order

    sheets = [

        "Assumptions", "Summary", "Tranche_Detail", "County_League_Model",

        "Unit_Economics", "Cash_Runway", "Pay_Triggers", "Milestones",

        "Scenarios", "Scenarios_Output", "Sales_Comp", "Infra_Estimates"

    ]

    for sheet_name in sheets:

        wb.create_sheet(title=sheet_name)

        

    return wb



def apply_styles(wb):

    """Defines and returns standard styles."""

    styles = {

        'title': Font(bold=True, size=16),

        'header': Font(bold=True, color="FFFFFF"),

        'header_fill': PatternFill(start_color="4F81BD", end_color="4F81BD", fill_type="solid"),

        'subheader': Font(bold=True, size=12),

        'input_fill': PatternFill(start_color="DDEBF7", end_color="DDEBF7", fill_type="solid"),

        'input_font': Font(color="0000FF", bold=True),

        'currency': openpyxl.styles.NamedStyle(name='currency', number_format='$#,##0'),

        'percent': openpyxl.styles.NamedStyle(name='percent', number_format='0.0%'),

        'integer': openpyxl.styles.NamedStyle(name='integer', number_format='#,##0'),

        'float': openpyxl.styles.NamedStyle(name='float', number_format='0.00'),

    }

    

    # Add named styles to workbook

    if 'currency' not in wb.style_names:

        wb.add_named_style(styles['currency'])

    if 'percent' not in wb.style_names:

        wb.add_named_style(styles['percent'])

    if 'integer' not in wb.style_names:

        wb.add_named_style(styles['integer'])

    if 'float' not in wb.style_names:

        wb.add_named_style(styles['float'])

        

    return styles



def style_sheet(ws, styles, col_widths={}):

    """Applies title, header, and column widths to a sheet."""

    ws['A1'].font = styles['title']

    

    # Apply header style to row 2

    for cell in ws[2]:

        cell.font = styles['header']

        cell.fill = styles['header_fill']

        cell.alignment = Alignment(horizontal="center", vertical="center")

        

    # Apply column widths

    for col, width in col_widths.items():

        ws.column_dimensions[col].width = width



    # Freeze top row

    ws.freeze_panes = 'A3'



def mark_input_cells(ws, cells, styles):

    """Applies blue font and light blue fill to input cells."""

    for cell_ref in cells:

        ws[cell_ref].font = styles['input_font']

        ws[cell_ref].fill = styles['input_fill']



# --- Sheet Population Functions ---



def populate_readme(ws, styles):

    ws['A1'] = "BLU Use-of-Funds Model - README"

    

    ws['A3'] = "How to Use This Model"

    ws['A3'].font = styles['subheader']

    

    instructions = [

        ("1.", "Start on the 'Assumptions' sheet. All key inputs are here."),

        ("2.", "Cells formatted in Blue with a Light Blue Background are inputs. Change these to test different scenarios."),

        ("3.", "All other cells contain formulas and will update automatically."),

        ("4.", "'County_League_Model' projects user growth and ARR based on your assumptions."),

        ("5.", "'Tranche_Detail' and 'Cash_Runway' allocate funds and project cash flow."),

        ("6.", "'Unit_Economics' and 'Milestones' track your key performance indicators (KPIs)."),

        ("7.", "'Scenarios' and 'Scenarios_Output' provide a high-level summary of Conservative, Base, and Aggressive outcomes."),

    ]

    

    row = 5

    for item in instructions:

        ws[f'A{row}'] = item[0]

        ws[f'B{row}'] = item[1]

        row += 1

        

    style_sheet(ws, styles, {'A': 5, 'B': 100})



def populate_assumptions(ws, styles):

    ws['A1'] = "Assumptions"

    

    headers = ["Category", "Item", "Base", "Conservative", "Aggressive", "Notes"]

    ws.append(headers)

    

    data = [

        # Market

        ("Market", "Counties Targeted (Year 1)", 5, 3, 8, "Initial focus area"),

        ("Market", "Leagues per County (Avg)", 20, 15, 25, ""),

        ("Market", "Umpires per League (Avg)", 15, 12, 18, ""),

        ("Market", "Parents per Umpire (Avg)", 10, 8, 12, "Parents of players in games umpired"),

        ("Market", "Coaches per League (Avg)", 8, 6, 10, ""),

        # Conversion

        ("Conversion", "Parent App Conversion %", 0.02, 0.01, 0.03, "Freemium to Paid ($199/yr)"),

        ("Conversion", "Coach App Conversion %", 0.10, 0.05, 0.15, "Freemium to Paid ($199/yr)"),

        ("Conversion", "League/Org Conversion % (Yr 1)", 0.05, 0.03, 0.08, "Leagues converting to B2B platform"),

        # Pricing

        ("Pricing", "Coach/Parent App (Annual)", 199, 199, 249, "Annual subscription"),

        ("Pricing", "Organization Price (Annual Avg)", 5000, 3500, 7500, "Per league, custom pricing"),

        # Unit Economics

        ("Unit Economics", "User Lifetime (Years)", 3, 2.5, 3.5, ""),

        ("Unit Economics", "Gross Margin", 0.55, 0.50, 0.60, "Revenue minus COGS (Infra, Support)"),

        ("Unit Economics", "Annual Discount Rate", 0.10, 0.12, 0.08, "For LTV calculation (optional)"),

        # CAC

        ("CAC", "CAC - Ambassador ($/user)", 30, 40, 25, "Paid user (parent/coach)"),

        ("CAC", "CAC - Social/Digital ($/user)", 80, 100, 70, "Paid user (parent/coach)"),

        ("CAC", "CAC - Organization ($/league)", 1200, 1500, 1000, "League B2B sale"),

        # Team & Ops

        ("Team", "Employer Burden", 0.10, 0.12, 0.10, "% on top of base salary (taxes, benefits)"),

        ("Team", "Engineer Salary (Avg)", 120000, 110000, 130000, ""),

        ("Team", "Sales Salary (Avg)", 80000, 75000, 85000, ""),

        # Pay Triggers

        ("Pay Triggers", "Founder Pay - Stage 1 (Annual)", 90000, 90000, 90000, "Annual Salary per Founder ($7.5k/mo)"),

        ("Pay Triggers", "Founder Pay - Stage 2 (Annual)", 120000, 120000, 120000, "Annual Salary per Founder ($10k/mo)"),

        ("Pay Triggers", "Founder Pay - Stage 3 (Annual)", 250000, 250000, 250000, "Annual Salary per Founder"),

        ("Pay Triggers", "MRR Trigger - Stage 2", 10000, 10000, 10000, "MRR threshold for Stage 2 pay"),

        ("Pay Triggers", "MRR Trigger - Stage 3", 50000, 50000, 50000, "MRR threshold for Stage 3 pay"),

        # Tranches

        ("Funding", "Tranche A", 250000, 250000, 250000, "MVP & Pilot"),

        ("Funding", "Tranche B", 750000, 750000, 750000, "Product-Market Fit"),

        ("Funding", "Tranche C", 1000000, 1000000, 1000000, "Growth"),

    ]

    

    input_cells = []

    for i, row_data in enumerate(data, 3):

        ws.append(row_data)

        # Mark Base, Conservative, Aggressive as inputs

        input_cells.extend([f'C{i}', f'D{i}', f'E{i}'])

        

    style_sheet(ws, styles, {'A': 20, 'B': 30, 'C': 15, 'D': 15, 'E': 15, 'F': 40})

    mark_input_cells(ws, input_cells, styles)

    

    # Apply formatting

    for row in ws['C3:E32']:

        for cell in row:

            if ws[f'B{cell.row}'].value and "Conversion" in ws[f'B{cell.row}'].value:

                cell.style = 'percent'

            elif ws[f'B{cell.row}'].value and "Margin" in ws[f'B{cell.row}'].value:

                cell.style = 'percent'

            elif ws[f'B{cell.row}'].value and "Burden" in ws[f'B{cell.row}'].value:

                cell.style = 'percent'

            elif ws[f'B{cell.row}'].value and "Rate" in ws[f'B{cell.row}'].value:

                cell.style = 'percent'

            elif ws[f'A{cell.row}'].value in ["Pricing", "CAC", "Team", "Pay Triggers", "Funding"]:

                 cell.style = 'currency'

            else:

                cell.style = 'integer'



def populate_summary(ws, styles):

    ws['A1'] = "Funding Tranche Summary"

    

    ws.append(["Tranche", "Amount", "Duration (Months)", "Primary Use", "Key Release Milestones"])

    

    data = [

        ("Tranche A", f"=Assumptions!C30", 9, "Build Umpire MVP & Launch Pilots", "Initial Close"),

        ("Tranche B", f"=Assumptions!C31", 12, "Achieve Product-Market Fit (Coach/Parent App)", "Tranche A Milestones Met (5 Leagues, 100 Umpires)"),

        ("Tranche C", f"=Assumptions!C32", 12, "Drive Scalable Growth (Organization Sales)", "Tranche B Milestones Met ($15k MRR, 2% Conversion)"),

    ]

    

    for row_data in data:

        ws.append(row_data)

        

    ws.append(["Total", "=SUM(B3:B5)", "=SUM(C3:C5)", "", ""])

    

    style_sheet(ws, styles, {'A': 15, 'B': 20, 'C': 20, 'D': 40, 'E': 50})

    

    # Style

    for cell in ws['B']:

        cell.style = 'currency'

    for cell in ws['C']:

        cell.style = 'integer'

    ws['B6'].font = ws['C6'].font = styles['subheader']



def populate_county_league_model(ws, styles):

    ws['A1'] = "County & League Growth Model (Base Scenario)"

    

    ws.append(["Metric", "Year 1", "Year 2", "Year 3", "Total"])



    # Growth Assumptions

    ws.append(["Counties Targeted (New)", f"=Assumptions!C3", 10, 20, "=SUM(B3:D3)"])

    ws.append(["New Leagues Acquired", f"=B3*Assumptions!C4", f"=C3*Assumptions!C4", f"=D3*Assumptions!C4", "=SUM(B4:D4)"])

    ws.append(["Total Leagues (Cumulative)", "=B4", "=B5+C4", "=C5+D4", "=D5"])

    

    # User Base

    ws.append(["", "", "", "", ""]) # Spacer

    ws.append(["User Base", "Year 1", "Year 2", "Year 3", "Total"])

    ws['A7'].font = styles['subheader']

    ws.append(["Total Umpires", f"=B5*Assumptions!C5", f"=C5*Assumptions!C5", f"=D5*Assumptions!C5", "=D8"])

    ws.append(["Total Parents (Potential)", f"=B8*Assumptions!C6", f"=C8*Assumptions!C6", f"=D8*Assumptions!C6", "=D9"])

    ws.append(["Total Coaches (Potential)", f"=B5*Assumptions!C7", f"=C5*Assumptions!C7", f"=D5*Assumptions!C7", "=D10"])

    

    # Paid Conversions

    ws.append(["", "", "", "", ""]) # Spacer

    ws.append(["Paid Conversions (New)", "Year 1", "Year 2", "Year 3", "Total"])

    ws['A12'].font = styles['subheader']

    ws.append(["Paid Parents", f"=B9*Assumptions!C8", f"=C9*Assumptions!C8", f"=D9*Assumptions!C8", "=SUM(B13:D13)"])

    ws.append(["Paid Coaches", f"=B10*Assumptions!C9", f"=C10*Assumptions!C9", f"=D10*Assumptions!C9", "=SUM(B14:D14)"])

    ws.append(["Paid Organizations", f"=B4*Assumptions!C10", f"=(C4*Assumptions!C10)", f"=(D4*Assumptions!C10)", "=SUM(B15:D15)"])

    

    # Revenue (ARR)

    ws.append(["", "", "", "", ""]) # Spacer

    ws.append(["Annual Recurring Revenue (ARR)", "Year 1", "Year 2", "Year 3", "Total"])

    ws['A17'].font = styles['subheader']

    ws.append(["Parent App Revenue", f"=B13*Assumptions!C11", f"=C13*Assumptions!C11", f"=D13*Assumptions!C11", "=SUM(B18:D18)"])

    ws.append(["Coach App Revenue", f"=B14*Assumptions!C11", f"=C14*Assumptions!C11", f"=D14*Assumptions!C11", "=SUM(B19:D19)"])

    ws.append(["Organization Revenue", f"=B15*Assumptions!C12", f"=C15*Assumptions!C12", f"=D15*Assumptions!C12", "=SUM(B20:D20)"])

    ws.append(["Total ARR", "=SUM(B18:B20)", "=SUM(C18:C20)", "=SUM(D18:D20)", "=SUM(B21:D21)"])

    ws.append(["Total MRR (Avg Year 3)", "", "", f"=D21/12", ""])

    

    style_sheet(ws, styles, {'A': 30, 'B': 18, 'C': 18, 'D': 18, 'E': 20})

    

    # Formatting

    for col in ['B', 'C', 'D', 'E']:

        for row in range(3, 23):

            cell = ws[f'{col}{row}']

            if row in [3, 4, 5, 8, 9, 10, 13, 14, 15]:

                cell.style = 'integer'

            if row in [18, 19, 20, 21, 22]:

                cell.style = 'currency'

    ws['D22'].style = 'currency'





def populate_tranche_detail(ws, styles):

    ws['A1'] = "Tranche Detail - Use of Funds"

    

    ws.append(["Category", "Item", "Tranche A", "Tranche B", "Tranche C", "Total"])



    data = [

        # Payroll

        ("Payroll", "Founders (2)", f"=Assumptions!C24*2* (Summary!C3/12)", f"=(Assumptions!C25*2*(3/12)) + (Assumptions!C26*2*(9/12))", f"=Assumptions!C26*2*(Summary!C5/12)", "=SUM(C3:E3)"),

        ("Payroll", "Engineers (2)", f"=(Assumptions!C21*2*(1+Assumptions!C20)) * (Summary!C3/12)", f"=(Assumptions!C21*2*(1+Assumptions!C20)) * (Summary!C4/12)", f"=(Assumptions!C21*2*(1+Assumptions!C20)) * (Summary!C5/12)", "=SUM(C4:E4)"),

        ("Payroll", "Sales (1 -> 2)", 0, f"=(Assumptions!C22*1*(1+Assumptions!C20)) * (Summary!C4/12)", f"=(Assumptions!C22*2*(1+Assumptions!C20)) * (Summary!C5/12)", "=SUM(C5:E5)"),

        ("Payroll", "Total Payroll", "=SUM(C3:C5)", "=SUM(D3:D5)", "=SUM(E3:E5)", "=SUM(F3:F5)"),

        # S&M

        ("Sales & Marketing", "CAC - Ambassador", 10000, 50000, 100000, "=SUM(C8:E8)"),

        ("Sales & Marketing", "CAC - Social/Digital", 20000, 75000, 150000, "=SUM(C9:E9)"),

        ("Sales & Marketing", "CAC - Organization", 5000, 30000, 60000, "=SUM(C10:E10)"),

        ("Sales & Marketing", "Total S&M", "=SUM(C8:C10)", "=SUM(D8:D10)", "=SUM(E8:E10)", "=SUM(F8:F10)"),

        # R&D

        ("R&D", "Software & Services", 15000, 30000, 50000, "=SUM(C13:E13)"),

        ("R&D", "Total R&D", "=C13", "=D13", "=E13", "=F13"),

        # Infra

        ("Infra", "Hosting & Data", f"=Infra_Estimates!F6* (Summary!C3/12)", f"=Infra_Estimates!F6", f"=Infra_Estimates!F6*1.5", "=SUM(C16:E16)"), # Simplified

        ("Infra", "Total Infra", "=C16", "=D16", "=E16", "=F16"),

        # G&A

        ("G&A", "Legal & Admin", 20000, 30000, 40000, "=SUM(C19:E19)"),

        ("G&A", "Office & Misc", 10000, 20000, 30000, "=SUM(C20:E20)"),

        ("G&A", "Total G&A", "=SUM(C19:C20)", "=SUM(D19:D20)", "=SUM(E19:E20)", "=SUM(F19:F20)"),

        # Totals

        ("", "", "", "", "", ""),

        ("Total Allocation", "", "=SUM(C6,C11,C14,C17,C21)", "=SUM(D6,D11,D14,D17,D21)", "=SUM(E6,E11,E14,E17,E21)", "=SUM(F6,F11,F14,F17,F21)"),

        ("Tranche Amount", "", f"=Assumptions!C30", f"=Assumptions!C31", f"=Assumptions!C32", "=SUM(C24:E24)"),

        ("Surplus / Deficit", "", "=C24-C23", "=D24-D23", "=E24-E23", "=F24-F23"),

    ]

    

    for row_data in data:

        ws.append(row_data)



    style_sheet(ws, styles, {'A': 20, 'B': 25, 'C': 18, 'D': 18, 'E': 18, 'F': 20})



    # Formatting

    for row in ws.iter_rows(min_row=3, max_row=25, min_col=3, max_col=6):

        for cell in row:

            cell.style = 'currency'

            

    for row in [6, 11, 14, 17, 21, 23, 24, 25]:

        ws[f'A{row}'].font = ws[f'B{row}'].font = ws[f'C{row}'].font = ws[f'D{row}'].font = ws[f'E{row}'].font = ws[f'F{row}'].font = styles['subheader']



def populate_unit_economics(ws, styles):

    ws['A1'] = "Unit Economics (Base Scenario)"

    

    ws.append(["Metric", "Parent (App)", "Coach (App)", "Organization (League)", "Blended"])

    

    data = [

        ("ARPU (Annual)", f"=Assumptions!C11", f"=Assumptions!C11", f"=Assumptions!C12", f"=County_League_Model!D21 / (County_League_Model!D13 + County_League_Model!D14 + County_League_Model!D15)"),

        ("Gross Margin", f"=Assumptions!C15", f"=Assumptions!C15", f"=Assumptions!C15", f"=Assumptions!C15"),

        ("Contribution Margin (Annual)", "=B3*B4", "=C3*C4", "=D3*D4", "=E3*E4"),

        ("Lifetime (Years)", f"=Assumptions!C14", f"=Assumptions!C14", f"=Assumptions!C14", f"=Assumptions!C14"),

        ("LTV", "=B5*B6", "=C5*C6", "=D5*D6", "=E5*E6"),

        ("", "", "", "", ""), # Spacer

        ("CAC", f"=Assumptions!C18", f"=Assumptions!C18", f"=Assumptions!C19", "N/A"), # Simplified CAC

        ("LTV / CAC Ratio", "=B7/B9", "=C7/C9", "=D7/D9", "N/A"),

        ("Payback Period (Months)", f"=(B9/B5)*12", f"=(C9/C5)*12", f"=(D9/D5)*12", "N/A"),

    ]

    

    for row_data in data:

        ws.append(row_data)



    style_sheet(ws, styles, {'A': 30, 'B': 18, 'C': 18, 'D': 20, 'E': 18})



    # Formatting

    for row in [3, 5, 7, 9]:

        for col in ['B', 'C', 'D', 'E']:

            ws[f'{col}{row}'].style = 'currency'

    ws['B4'].style = ws['C4'].style = ws['D4'].style = ws['E4'].style = 'percent'

    for row in [6, 10]:

        for col in ['B', 'C', 'D', 'E']:

            ws[f'{col}{row}'].style = 'float'

    ws['B11'].style = ws['C11'].style = ws['D11'].style = ws['E11'].style = 'float'

    

    # Color scale for LTV/CAC

    ws.conditional_formatting.add('B10:D10', ColorScaleRule(start_type='num', start_value=1, start_color='FF0000', mid_type='num', mid_value=3, mid_color='FFFF00', end_type='num', end_value=5, end_color='00B050'))



def populate_cash_runway(ws, styles):

    ws['A1'] = "Monthly Cash Runway"

    

    headers = [

        "Month", "Opening Cash", "Financing", "Revenue", "Total Cash In",

        "Payroll", "S&M", "R&D", "Infra", "G&A", "Total Cash Out",

        "Net Burn", "Closing Cash", "Runway (Months)"

    ]

    ws.append(headers)



    # Simplified monthly costs from tranches

    ws['O3'] = "Tranche A Monthly Burn"

    ws['P3'] = f"=(Tranche_Detail!C23) / Summary!C3"

    ws['O4'] = "Tranche B Monthly Burn"

    ws['P4'] = f"=(Tranche_Detail!D23) / Summary!C4"

    ws['O5'] = "Tranche C Monthly Burn"

    ws['P5'] = f"=(Tranche_Detail!E23) / Summary!C5"

    

    ws['O7'] = "Tranche A Monthly Payroll"

    ws['P7'] = f"=(Tranche_Detail!C6) / Summary!C3"

    ws['O8'] = "Tranche A Monthly S&M"

    ws['P8'] = f"=(Tranche_Detail!C11) / Summary!C3"

    # ... and so on for all categories

    

    # Month 1

    ws['A3'] = 1

    ws['B3'] = 0

    ws['C3'] = f"=Assumptions!C30" # Tranche A

    ws['D3'] = 0 # No revenue M1

    ws['E3'] = "=C3+D3"

    ws['F3'] = f"=(Tranche_Detail!C6) / Summary!C3"  # Payroll T-A

    ws['G3'] = f"=(Tranche_Detail!C11) / Summary!C3" # S&M T-A

    ws['H3'] = f"=(Tranche_Detail!C14) / Summary!C3" # R&D T-A

    ws['I3'] = f"=(Tranche_Detail!C17) / Summary!C3" # Infra T-A

    ws['J3'] = f"=(Tranche_Detail!C21) / Summary!C3" # G&A T-A

    ws['K3'] = "=SUM(F3:J3)"

    ws['L3'] = "=K3-D3" # Net Burn

    ws['M3'] = "=B3+E3-K3"

    ws['N3'] = f"=IF(L3>0, M3/L3, 999)"



    # Loop for 36 months

    for m in range(2, 37):

        row = m + 2

        ws[f'A{row}'] = m

        ws[f'B{row}'] = f"=M{row-1}" # Opening Cash

        

        # Financing Triggers

        if m == 10: # Tranche B trigger (Month 10)

             ws[f'C{row}'] = f"=Assumptions!C31"

        elif m == 22: # Tranche C trigger (Month 22)

            ws[f'C{row}'] = f"=Assumptions!C32"

        else:

            ws[f'C{row}'] = 0

            

        # Revenue (simple linear ramp to Year 1 ARR)

        ws[f'D{row}'] = f"=IF(A{row}<=12, (County_League_Model!B21/12)*(A{row}/12), IF(A{row}<=24, (County_League_Model!C21/12), (County_League_Model!D21/12)))"

        

        ws[f'E{row}'] = f"=C{row}+D{row}"

        

        # Determine which tranche's burn rate to use

        payroll_formula = f"=IF(A{row}<=Summary!C3, (Tranche_Detail!C6)/Summary!C3, IF(A{row}<=(Summary!C3+Summary!C4), (Tranche_Detail!D6)/Summary!C4, (Tranche_Detail!E6)/Summary!C5))"

        sm_formula = f"=IF(A{row}<=Summary!C3, (Tranche_Detail!C11)/Summary!C3, IF(A{row}<=(Summary!C3+Summary!C4), (Tranche_Detail!D11)/Summary!C4, (Tranche_Detail!E11)/Summary!C5))"

        rd_formula = f"=IF(A{row}<=Summary!C3, (Tranche_Detail!C14)/Summary!C3, IF(A{row}<=(Summary!C3+Summary!C4), (Tranche_Detail!D14)/Summary!C4, (Tranche_Detail!E14)/Summary!C5))"

        infra_formula = f"=IF(A{row}<=Summary!C3, (Tranche_Detail!C17)/Summary!C3, IF(A{row}<=(Summary!C3+Summary!C4), (Tranche_Detail!D17)/Summary!C4, (Tranche_Detail!E17)/Summary!C5))"

        ga_formula = f"=IF(A{row}<=Summary!C3, (Tranche_Detail!C21)/Summary!C3, IF(A{row}<=(Summary!C3+Summary!C4), (Tranche_Detail!D21)/Summary!C4, (Tranche_Detail!E21)/Summary!C5))"



        ws[f'F{row}'] = payroll_formula

        ws[f'G{row}'] = sm_formula

        ws[f'H{row}'] = rd_formula

        ws[f'I{row}'] = infra_formula

        ws[f'J{row}'] = ga_formula

        

        ws[f'K{row}'] = f"=SUM(F{row}:J{row})"

        ws[f'L{row}'] = f"=K{row}-D{row}"

        ws[f'M{row}'] = f"=B{row}+E{row}-K{row}"

        ws[f'N{row}'] = f"=IF(L{row}>0, M{row}/L{row}, 999)"



    style_sheet(ws, styles, {'A': 8, 'B': 18, 'C': 18, 'D': 18, 'E': 18, 'F': 18, 'G': 18, 'H': 18, 'I': 18, 'J': 18, 'K': 18, 'L': 18, 'M': 18, 'N': 18})

    

    # Formatting

    for row in ws.iter_rows(min_row=3, max_row=38, min_col=2, max_col=13):

        for cell in row:

            cell.style = 'currency'

    for row in ws.iter_rows(min_row=3, max_row=38, min_col=14, max_col=14):

        for cell in row:

            cell.style = 'float'

            

def populate_pay_triggers(ws, styles):

    ws['A1'] = "Founder Pay Triggers"

    

    ws.append(["Stage", "Annual Salary (per Founder)", "MRR Trigger", "Tranche Trigger", "Notes"])

    

    data = [

        (1, f"=Assumptions!C24", 0, "Tranche A", "MVP & Pilot Phase"),

        (2, f"=Assumptions!C25", f"=Assumptions!C27", "Tranche B", "PMF Phase"),

        (3, f"=Assumptions!C26", f"=Assumptions!C28", "Tranche C", "Scale Phase"),

    ]

    

    for row_data in data:

        ws.append(row_data)

        

    ws['A7'] = "Current Status"

    ws['A7'].font = styles['subheader']

    ws['A8'] = "Current MRR"

    ws['B8'] = f"=County_League_Model!D22" # Using Year 3 Avg MRR as placeholder

    ws['A9'] = "Current Annual Pay (per)"

    ws['B9'] = f"=IF(B8>=C4, B4, IF(B8>=C3, B3, B2))"

    ws['A10'] = "Total Founder Payroll (Annual)"

    ws['B10'] = f"=B9*2"

    

    style_sheet(ws, styles, {'A': 30, 'B': 25, 'C': 18, 'D': 18, 'E': 30})

    

    # Formatting

    for col in ['B', 'C']:

        for row in [3, 4, 5, 8, 9, 10]:

            ws[f'{col}{row}'].style = 'currency'

            

def populate_milestones(ws, styles):

    ws['A1'] = "Milestones & KPIs"

    

    ws.append(["Tranche", "Milestone", "Metric", "Target", "Current", "Status"])

    

    data = [

        ("A", "MVP Launch", "App Live", 1, 1, "=IF(E3>=D3,\"Met\",\"Pending\")"),

        ("A", "Umpires Onboarded", "Users", 100, 0, "=IF(E4>=D4,\"Met\",\"Pending\")"),

        ("A", "Pilot Leagues Secured", "Leagues", 5, f"=County_League_Model!B5", "=IF(E5>=D5,\"Met\",\"Pending\")"),

        

        ("B", "Tranche A Milestones Met", "Status", 1, f"=IF(F5=\"Met\",1,0)", "=IF(E6>=D6,\"Met\",\"Pending\")"),

        ("B", "Achieve $15k MRR", "MRR", 15000, f"=County_League_Model!D22", "=IF(E7>=D7,\"Met\",\"Pending\")"),

        ("B", "Parent Conversion", "%", f"=Assumptions!C8", f"=Assumptions!C8", "=IF(E8>=D8,\"Met\",\"Pending\")"),

        ("B", "Coach Conversion", "%", f"=Assumptions!C9", f"=Assumptions!C9", "=IF(E9>=D9,\"Met\",\"Pending\")"),

        

        ("C", "Tranche B Milestones Met", "Status", 1, f"=IF(AND(F7=\"Met\",F8=\"Met\",F9=\"Met\"),1,0)", "=IF(E10>=D10,\"Met\",\"Pending\")"),

        ("C", "Achieve $100k MRR", "MRR", 100000, f"=County_League_Model!D22", "=IF(E11>=D11,\"Met\",\"Pending\")"),

        ("C", "Org Contracts", "Count", 10, f"=County_League_Model!D15", "=IF(E12>=D12,\"Met\",\"Pending\")"),

    ]

    

    for row_data in data:

        ws.append(row_data)



    style_sheet(ws, styles, {'A': 10, 'B': 30, 'C': 20, 'D': 15, 'E': 15, 'F': 15})

    

    # Formatting

    ws['D8'].style = ws['E8'].style = 'percent'

    ws['D9'].style = ws['E9'].style = 'percent'

    ws['D7'].style = ws['E7'].style = 'currency'

    ws['D11'].style = ws['E11'].style = 'currency'

    mark_input_cells(ws, ['E3', 'E4'], styles) # Mark 'Current' as manual inputs for non-formula items



def populate_scenarios(ws, styles):

    ws['A1'] = "Scenario Assumptions"

    

    ws.append(["Variable", "Conservative", "Base", "Aggressive"])

    

    data = [

        ("Parent Conversion %", f"=Assumptions!D8", f"=Assumptions!C8", f"=Assumptions!E8"),

        ("Coach Conversion %", f"=Assumptions!D9", f"=Assumptions!C9", f"=Assumptions!E9"),

        ("Org Conversion %", f"=Assumptions!D10", f"=Assumptions!C10", f"=Assumptions!E10"),

        ("Org Price (Annual Avg)", f"=Assumptions!D12", f"=Assumptions!C12", f"=Assumptions!E12"),

        ("CAC - Ambassador", f"=Assumptions!D17", f"=Assumptions!C17", f"=Assumptions!E17"),

        ("CAC - Social/Digital", f"=Assumptions!D18", f"=Assumptions!C18", f"=Assumptions!E18"),

        ("CAC - Organization", f"=Assumptions!D19", f"=Assumptions!C19", f"=Assumptions!E19"),

    ]

    

    for row_data in data:

        ws.append(row_data)

        

    style_sheet(ws, styles, {'A': 30, 'B': 18, 'C': 18, 'D': 18})



    # Formatting

    for row in [3, 4, 5]:

        for col in ['B', 'C', 'D']:

            ws[f'{col}{row}'].style = 'percent'

    for row in [6, 7, 8, 9]:

        for col in ['B', 'C', 'D']:

            ws[f'{col}{row}'].style = 'currency'



def populate_scenarios_output(ws, styles):

    ws['A1'] = "Scenarios Output Summary"

    

    ws.append(["Metric", "Conservative", "Base", "Aggressive"])

    

    # These formulas are re-calculations of the model based on scenario inputs

    # This is a simplified version. A full model would use CHOOSE or OFFSET.

    

    # Year 3 ARR

    ws['A3'] = "Year 3 ARR"

    ws['B3'] = f"=(County_League_Model!D9*Scenarios!B3*Assumptions!D11) + (County_League_Model!D10*Scenarios!B4*Assumptions!D11) + (County_League_Model!D15*Scenarios!B6)"

    ws['C3'] = f"=County_League_Model!D21" # Base

    ws['D3'] = f"=(County_League_Model!D9*Scenarios!D3*Assumptions!E11) + (County_League_Model!D10*Scenarios!D4*Assumptions!E11) + (County_League_Model!D15*Scenarios!D6)"

    

    # Year 3 Total Paid Users

    ws['A4'] = "Year 3 Total Paid Users"

    ws['B4'] = f"=(County_League_Model!D9*Scenarios!B3) + (County_League_Model!D10*Scenarios!B4) + (County_League_Model!D15)"

    ws['C4'] = f"=County_League_Model!D13 + County_League_Model!D14 + County_League_Model!D15"

    ws['D4'] = f"=(County_League_Model!D9*Scenarios!D3) + (County_League_Model!D10*Scenarios!D4) + (County_League_Model!D15)"

    

    # Blended LTV

    ws['A5'] = "Blended LTV (Year 3)"

    ws['B5'] = f"=(B3/B4) * Assumptions!D14 * Assumptions!D13"

    ws['C5'] = f"=Unit_Economics!E7"

    ws['D5'] = f"=(D3/D4) * Assumptions!E14 * Assumptions!E13"

    

    # Blended Payback (Months)

    ws['A6'] = "Blended Payback (Months) - Est."

    ws['B6'] = f"( (Scenarios!B7*B4) + (Scenarios!B9*County_League_Model!D15) ) / (B3*Assumptions!D14) * 12" # Very simplified

    ws['C6'] = f"=Unit_Economics!E11"

    ws['D6'] = f"( (Scenarios!D7*D4) + (Scenarios!D9*County_League_Model!D15) ) / (D3*Assumptions!E14) * 12" # Very simplified

    

    style_sheet(ws, styles, {'A': 30, 'B': 18, 'C': 18, 'D': 18})

    

    # Formatting

    for row in [3, 5]:

        for col in ['B', 'C', 'D']:

            ws[f'{col}{row}'].style = 'currency'

    for row in [4]:

        for col in ['B', 'C', 'D']:

            ws[f'{col}{row}'].style = 'integer'

    for row in [6]:

        for col in ['B', 'C', 'D']:

            ws[f'{col}{row}'].style = 'float'



def populate_sales_comp(ws, styles):

    ws['A1'] = "Sales Comp Model (Example)"

    

    ws.append(["Role", "Base Salary", "Commission Rate", "Bonus Target", "Notes / Triggers"])

    

    data = [

        ("Org Sales Rep (Tranche B)", f"=Assumptions!C22", 0.10, 20000, "10% of 1st Year ACV. Bonus on 100% quota."),

        ("Partner Manager (Tranche C)", 90000, 0.05, 15000, "5% of ACV from league partners."),

        ("Head of Sales (Tranche C)", 140000, 0.02, 50000, "2% team override. Bonus on team quota."),

    ]

    

    for row_data in data:

        ws.append(row_data)



    style_sheet(ws, styles, {'A': 30, 'B': 18, 'C': 18, 'D': 18, 'E': 40})

    

    # Formatting

    ws['B3'].style = ws['B4'].style = ws['B5'].style = 'currency'

    ws['D3'].style = ws['D4'].style = ws['D5'].style = 'currency'

    ws['C3'].style = ws['C4'].style = ws['C5'].style = 'percent'



def populate_infra_estimates(ws, styles):

    ws['A1'] = "Infrastructure Cost Estimates"

    

    ws.append(["Item", "Cost Driver", "Cost per Unit", "Units (Year 2)", "Total Annual Cost", "Notes"])

    

    data = [

        ("Umpire Onboarding/Training", "Per Umpire", 10, f"=County_League_Model!C8", "=C3*D3", "Manuals, support, background check subsidy"),

        ("Audio Data Storage (Cloud)", "Per Game (Avg)", 0.50, f"=(County_League_Model!C8*20)", "=C4*D4", "Assuming 20 games/umpire/year"),

        ("Data Processing (AI)", "Per Game (Avg)", 1.00, f"=D4", "=C5*D5", "Analytics & transcription costs"),

    ]

    

    for row_data in data:

        ws.append(row_data)



    ws['A6'] = "Total Annual Infra COGS"

    ws['E6'] = "=SUM(E3:E5)"

    ws['E6'].font = styles['subheader']

    

    ws['A8'] = "Adjusted Gross Margin"

    ws['A8'].font = styles['subheader']

    ws['A9'] = "Base Gross Margin"

    ws['B9'] = f"=Assumptions!C15"

    ws['A10'] = "Infra COGS as % of Revenue (Y2)"

    ws['B10'] = f"=E6/County_League_Model!C21"

    ws['A11'] = "Adjusted Gross Margin"

    ws['B11'] = "=B9-B10"

    

    style_sheet(ws, styles, {'A': 30, 'B': 20, 'C': 15, 'D': 18, 'E': 20, 'F': 40})

    

    # Formatting

    ws['C3'].style = ws['C4'].style = ws['C5'].style = 'currency'

    ws['E3'].style = ws['E4'].style = ws['E5'].style = ws['E6'].style = 'currency'

    ws['D3'].style = ws['D4'].style = ws['D5'].style = 'integer'

    ws['B9'].style = ws['B10'].style = ws['B11'].style = 'percent'





# --- Main execution ---

def main():

    wb = setup_workbook()

    styles = apply_styles(wb)

    

    populate_readme(wb['README'], styles)

    populate_assumptions(wb['Assumptions'], styles)

    populate_summary(wb['Summary'], styles)

    populate_tranche_detail(wb['Tranche_Detail'], styles)

    populate_county_league_model(wb['County_League_Model'], styles)

    populate_unit_economics(wb['Unit_Economics'], styles)

    populate_cash_runway(wb['Cash_Runway'], styles)

    populate_pay_triggers(wb['Pay_Triggers'], styles)

    populate_milestones(wb['Milestones'], styles)

    populate_scenarios(wb['Scenarios'], styles)

    populate_scenarios_output(wb['Scenarios_Output'], styles)

    populate_sales_comp(wb['Sales_Comp'], styles)

    populate_infra_estimates(wb['Infra_Estimates'], styles)



    # Set 'Assumptions' as the active sheet

    wb.active = wb['Assumptions']

    

    # Save the workbook

    file_name = "BLU Use-of-Funds Model.xlsx"

    wb.save(file_name)

    print(f"Successfully created '{file_name}'")



if __name__ == "__main__":

    main()

