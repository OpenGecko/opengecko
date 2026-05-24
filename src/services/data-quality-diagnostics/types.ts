
import type { buildCoverageMatrix } from '../coverage-matrix';
import type { buildGlobalPublicRouteData } from '../../modules/global';
import type { QualityDimensionId, QualityStatus } from '../data-quality-contract';

export type CoverageMatrix = ReturnType<typeof buildCoverageMatrix>;
export type CoverageEntry = CoverageMatrix['entries'][number];
export type GlobalPublicRouteData = ReturnType<typeof buildGlobalPublicRouteData>;

export type QualityDimension = {
  id: QualityDimensionId;
  score: number;
  status: QualityStatus;
  weight: number;
  reason_codes: string[];
  message: string;
};

export type QualityFamilyConfig = {
  family: string;
  aliases: string[];
  runtimeFamilyIds: string[];
  required: boolean;
  representativeRoutes: string[];
  coverageFamily?: string;
  contractEvidence: string[];
  fallbackCoverageFamily?: string;
  outOfScope?: boolean;
};
