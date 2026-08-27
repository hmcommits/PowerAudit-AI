// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Ported verbatim from scripts/recalculate_bills.py's STUB_TARIFF_PARAMS/
 * STUB_CITATION. STUBBED, NOT REAL - stands in for what Section 4 step 2
 * describes as "RocketRide Vector search - retrieves the current tariff
 * formula". rocketride_vector's document-store step is confirmed broken on
 * this server (docs/CLAUDE.md Backlog) - once fixed, replace this with an
 * actual per-DISCOM Vector lookup. Keep in sync with the Python source by
 * hand if either changes.
 */

export interface TariffParams {
	demandChargeRate: number;
	penaltyMultiplier: number;
	incentiveThreshold: number;
	surchargeThreshold: number;
	incentiveRatePerPoint: number;
	surchargeRatePerPoint: number;
}

export const STUB_TARIFF_PARAMS: Record<string, TariffParams> = {
	MSEDCL: { demandChargeRate: 450, penaltyMultiplier: 1.75, incentiveThreshold: 0.95, surchargeThreshold: 0.9, incentiveRatePerPoint: 0.005, surchargeRatePerPoint: 0.01 },
	'TATA Power': { demandChargeRate: 480, penaltyMultiplier: 1.5, incentiveThreshold: 0.95, surchargeThreshold: 0.9, incentiveRatePerPoint: 0.005, surchargeRatePerPoint: 0.01 },
	BESCOM: { demandChargeRate: 420, penaltyMultiplier: 2.0, incentiveThreshold: 0.95, surchargeThreshold: 0.9, incentiveRatePerPoint: 0.005, surchargeRatePerPoint: 0.01 },
	'Adani Electricity': { demandChargeRate: 460, penaltyMultiplier: 1.5, incentiveThreshold: 0.95, surchargeThreshold: 0.9, incentiveRatePerPoint: 0.005, surchargeRatePerPoint: 0.01 },
};

export const STUB_CITATION = "[STUB - Vector citation-attacher not wired: rocketride_vector's store step is broken, see docs/CLAUDE.md Backlog]";
