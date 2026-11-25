import {
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  GitFork,
  GitMerge,
  Navigation,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import type { TurnManeuverKind } from '../../lib/navigationEngine';

export function ManeuverIcon({
  maneuver,
  className = 'h-7 w-7',
}: {
  maneuver: TurnManeuverKind;
  className?: string;
}) {
  switch (maneuver) {
    case 'turn-left':
    case 'turn-sharp-left':
      return <CornerUpLeft className={className} aria-hidden />;
    case 'turn-slight-left':
      return <ArrowUpLeft className={className} aria-hidden />;
    case 'turn-right':
    case 'turn-sharp-right':
      return <CornerUpRight className={className} aria-hidden />;
    case 'turn-slight-right':
      return <ArrowUpRight className={className} aria-hidden />;
    case 'uturn-left':
    case 'uturn-right':
      return <Undo2 className={className} aria-hidden />;
    case 'roundabout':
      return <RefreshCw className={className} aria-hidden />;
    case 'merge':
      return <GitMerge className={className} aria-hidden />;
    case 'fork-left':
    case 'fork-right':
      return <GitFork className={className} aria-hidden />;
    case 'arrive':
      return <Flag className={className} aria-hidden />;
    case 'depart':
      return <Navigation className={className} aria-hidden />;
    case 'straight':
    default:
      return <ArrowUp className={className} aria-hidden />;
  }
}
