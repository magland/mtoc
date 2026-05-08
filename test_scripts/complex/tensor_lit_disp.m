% Complex tensor literals + tensor disp.
% Hits every branch of formatComplex simultaneously:
%   im == 0         → real-format path (cell with bare real)
%   re == 0         → "<im>i"
%   im < 0          → "<re> - <|im|>i"
%   else (im > 0)   → "<re> + <im>i"
A = [1, 2 + 3i; -4i, 5 - 6i];
disp(A);

% Mixed real cells with complex cells; padding sees mixed widths.
B = [1 + 2i, 3, -7i; 0, 4 - 5i, 8 + 9i];
disp(B);

% Pure-imag and zero rows.
C = [1i, 2i; -3i, 0 + 4i];
disp(C);

% Single-row / single-column complex tensors.
D = [1 + 1i, 2 + 2i, 3 + 3i];
disp(D);
