% min / max on complex scalar pairs.
% Numbl orders complex by magnitude with angle as tiebreaker; mtoc
% mirrors that via mtoc_min_complex / mtoc_max_complex runtime helpers.
disp(min(1 + 2i, 3 + 4i));    % |1+2i|≈2.236 < |3+4i|=5  → 1+2i
disp(max(1 + 2i, 3 + 4i));    % → 3+4i
disp(min(2i, 3));              % |2i|=2, |3|=3 → 2i (complex)
disp(max(2i, 3));              % → 3 (formats as real because im==0)

% Equal-magnitude tiebreak by angle.
disp(min(1 + 1i, 1 - 1i));    % both have magnitude sqrt(2); atan2(1,1)>atan2(-1,1) → pick 1-1i for min
disp(max(1 + 1i, 1 - 1i));    % → pick 1+1i for max

% Pure-real inputs still go through the real-libm fmin/fmax path.
disp(min(2, 5));
disp(max(2, 5));
