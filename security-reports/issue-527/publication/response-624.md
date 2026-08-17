<!-- response-review-4944862716 -->

The intended VPS threat model is a trusted operator running Ultrafuzz with the dashboard bound to loopback and reaching it through an SSH tunnel. Public reverse-proxy exposure was outside the intended model and was not considered safe by default.

The proposed hardening would still have been relevant defense in depth on a VPS, but this entire group is now deferred under the requested ≤2,000-line prioritization. The branch is retained and unmerged.
