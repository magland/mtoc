% reshape() to a 3-D tensor + disp / size / ndims / numel / length.
% Exercises the N-D page-by-page disp format and the min-2 padding
% conventions of size/ndims.

v = [1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24];
A = reshape(v, 2, 3, 4);

disp(A);                  % four 2x3 pages with (:,:,k) = headers

disp(ndims(A));           % 3
disp(numel(A));           % 24
disp(length(A));          % 4 (max dim)

sz = size(A);
disp(sz);                 % [2 3 4]

disp(size(A, 1));         % 2
disp(size(A, 2));         % 3
disp(size(A, 3));         % 4
disp(size(A, 4));         % 1 (implicit trailing singleton)
