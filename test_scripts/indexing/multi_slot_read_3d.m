% N-D multi-slot reads on a 3-D tensor.
v = [1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24];
T = reshape(v, 2, 3, 4);
disp(T(:, :, 1));    % first plane along axis 2 -> 2x3 matrix
disp(T(:, 2, :));    % middle row of each plane -> 2x1x4
disp(T(1, :, :));    % first row of each plane  -> 1x3x4
disp(T(end, :, end));% last row of last plane   -> 1x3
