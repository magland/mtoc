% NonConjugateTranspose (`.'`) on complex tensors. `.'` does NOT
% conjugate the imag lane (that's `'`), so imag parts are reordered
% but their sign is preserved.

A = [1 + 2i, 3 + 4i; 5 + 6i, 7 + 8i];
disp(A.');                  % [1+2i 5+6i; 3+4i 7+8i]

% Complex row → complex column.
r = [1i, 2i, 3i];
disp(r.');
disp(size(r.'));            % [3 1]

% Compose with elementwise arithmetic.
B = A.' + 100i;
disp(B);
