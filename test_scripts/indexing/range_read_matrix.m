% Linear range / colon indexing into a matrix.
%   - `M(:)` linearizes to a column vector.
%   - `M(a:b)` linear-indexes and returns a row vector (the `a:b`
%     index itself is a row, and the index orientation wins for a
%     matrix base under linear indexing — matches numbl).
M = [1 2 3; 4 5 6];
a = M(:); disp(a);
b = M(2:5); disp(b);
c = M(end:-1:1); disp(c);
% End in a matrix linear context resolves to numel(M) = rows*cols.
d = M(1:end); disp(d);
