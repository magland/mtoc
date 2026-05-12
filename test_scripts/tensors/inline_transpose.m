% Exercises the transpose inlining peephole
% (src/codegen/opt/inlineTranspose.ts). The compiled program must
% remain byte-for-byte identical to numbl's interpretation; correctness
% of the swap-axis index math is what's checked here.

% Column + transposed column → square broadcast (the lap2d-shaped
% pattern minus the slice).
col = [10; 20; 30];
sq = col + col.';
disp(sq);

% Row + transposed row → square broadcast (the dual shape).
row = [1 2 3 4];
sq2 = row + row.';
disp(sq2);

% Transposed column combined with a row of different size — exercises
% the case where the transpose's swapped dim has to broadcast against
% another notOne axis.
r = [100 200 300];
mixed = col.' - r;
disp(mixed);
