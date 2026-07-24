#!/usr/bin/env python
"""Train and export a CSP+LDA model.

    python train.py A01T.gdf                      # -> csp_lda_global.onnx
    python train.py --subject s1 A01T.gdf         # -> csp_lda_s1.onnx
    python train.py A01T.gdf A02T.gdf A03T.gdf    # pooled across subjects
    python train.py --coefficients                # print the filter table

The two output files land in MODEL_DIR and must be deployed together — they are
only valid as a pair from the same run.
"""

from __future__ import annotations

import argparse
import logging
import sys

from app import config
from app.training import DEFAULT_COMPONENTS, print_filter_coefficients, train_model


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("recordings", nargs="*", help="BCI Competition IV 2a .gdf training files")
    parser.add_argument(
        "--subject",
        default=config.DEFAULT_MODEL_ID,
        help=f"Model id to export under (default: {config.DEFAULT_MODEL_ID})",
    )
    parser.add_argument(
        "--components",
        type=int,
        default=DEFAULT_COMPONENTS,
        help=f"Number of CSP components (default: {DEFAULT_COMPONENTS})",
    )
    parser.add_argument(
        "--no-notch",
        action="store_true",
        help="Fit without the mains notch. Only do this if the server also runs without it.",
    )
    parser.add_argument(
        "--coefficients",
        action="store_true",
        help="Print the SciPy filter sections for filters.service.ts and exit",
    )

    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if args.coefficients:
        print_filter_coefficients()
        return 0

    if not args.recordings:
        parser.error("give at least one .gdf recording, or use --coefficients")

    try:
        summary = train_model(
            args.recordings,
            model_id=args.subject,
            n_components=args.components,
            notch=not args.no_notch,
        )
    except Exception as error:  # noqa: BLE001 - CLI reports rather than traces
        print(f"error: {error}", file=sys.stderr)
        return 1

    print()
    print(f"  model      {summary['model_id']}")
    print(f"  epochs     {summary['epochs']}")
    print(f"  components {summary['n_components']}")
    print(f"  accuracy   {summary['cv_accuracy']:.1%} (5-fold CV)")
    print(f"  onnx       {summary['onnx']}")
    print(f"  csp        {summary['csp']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
