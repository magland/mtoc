% fid 1 and fid 2: numbl routes both to its single output stream
% (see specialBuiltins.ts), so mtoc emits both to stdout too — the
% cross-runner comparison is stdout-only and would diverge if mtoc
% sent fid=2 to stderr.
fprintf(1, 'to stdout via fid=1\n');
fprintf(2, 'to stdout via fid=2 in numbl\n');
fprintf(1, 'count=%d items\n', 5);
fprintf(2, 'value=%g\n', 3.14);
