# Strategic Energy & EV Tariff Report: MSEDCL, TGSPDCL, & BESCOM

## Key Tariff Constants (Source of Truth for tariff_penalty_calculator.py)

### MSEDCL (Maharashtra)
- EV Charging Tariff: Rs.9.50/unit (HT and LT both)
- Demand Charges: Applicable based on load
- GEOA threshold: 100 kW and above
- MD Penalty: If Recorded MD > Contract Demand x 1.10 -> excess x rate x 2
- PF Penalty: PF < 0.90 triggers penalty; PF >= 0.95 earns incentive
- ToD: Highly enforced, peak-hour penalties, off-peak discounts
- Tariff Order Reference: MSEDCL MYT Order 2026-27

### TGSPDCL / TSSPDCL (Telangana)
- EV Charging Tariff HT: ~Rs.6.10/kWh (single-part, NO demand charges)
- EV Charging Tariff LT: ~Rs.6.70/kWh (single-part, NO demand charges)
- Commercial Tariff: Rs.7.50 - Rs.9.50/unit
- Industrial Tariff: Rs.7.00 - Rs.11.00/unit
- MD Penalty: If MD > CD x 1.10 -> penalty = excess x rate x 1.5
- PF Penalty: PF < 0.90; rate_per_unit = 0.9 (concessional vs MSEDCL)
- Demand Charges for EV: ZERO (single-part tariff)
- Tariff Order Reference: TSERC Schedule of Tariffs 2024, Clause 14 (MD), Clause 15.2 (PF)

### BESCOM (Karnataka)
- EV Charging Tariff: Rs.5.50 - Rs.6.50/unit (LT-6a category, NO demand charges)
- C&I Penal MD Rate: 2x normal rate if MD exceeds sanctioned load
- MD Penalty Multiplier: 2x (confirmed in whitepaper)
- MD base rate: Rs.230/kVA/month (HT-2(a) category)
- ToD: Mandatory for HT2(a), HT2(b), HT2(c) with CD >= 500 kVA; Optional below 500 kVA
- Off-season tariff: Available up to 6 months/year (for overhauling/repair)
- EV Land Aggregator Portal: PM E-DRIVE initiative
- Tariff Order Reference: BESCOM Tariff Order 2024, Clause 11(a) (MD), Clause 12 (PF)

## PF Target (All DISCOMs)
- Mandatory: PF > 0.90 (penalty below this)
- Target: PF >= 0.95 (incentive/rebate above this)
- APFC (Automatic Power Factor Correction) panels recommended

## EV Charging Economics Summary
| Metric              | MSEDCL           | TGSPDCL         | BESCOM          |
|---------------------|------------------|-----------------|-----------------|
| EV Tariff           | Rs.9.50/unit     | Rs.6.10 (HT)    | Rs.5.50-6.50    |
| Demand Charges      | Applicable       | ZERO            | ZERO            |
| Best Segment        | Malls/Retail     | Logistics Fleets| Tech Parks      |

## Sector Strategy Notes

### Retail Chains
- MSEDCL: Pool 5-10 outlets to hit 100 kW GEOA threshold; PPA solar ~Rs.4.00-4.80/unit
- Rooftop solar + Net Metering (BESCOM and MSEDCL both offer)
- EV charging as revenue stream: Separate LT-6a meter (KA/TS) -> zero fixed charges

### Manufacturers
- ToD load shifting: Off-peak = 10 PM - 6 AM
- Group Captive Solar: 26% equity -> waive Cross Subsidy Surcharge (CSS) -> <Rs.4.00/unit
- Max Demand Management: IoT energy management to sequence heavy motor starts
- BESCOM off-season tariff: 6 months/year for maintenance

### Logistics Networks
- TSSPDCL: HT EV meter Rs.6.10/unit, zero fixed charges -> ideal for fleet charging hubs
- Night charging (post 11 PM) = ToD off-peak = cheapest electrons
- Solar + BESS: Generate daytime, store, charge fleet at night

## Compliance Imperatives
1. Separate EV meter from commercial/industrial meter (avoid MD spikes)
2. MSEDCL GEOA aggregation for retail chains (100 kW threshold)
3. PF > 0.95 target via APFC panels (avoids penalty, earns rebate all 3 DISCOMs)
